"use strict";

/*
 * GC CONTROLS
 * -----------
 * - Lock GC name      : if anyone renames the group, the bot renames it back.
 * - Set all nicknames : set (or clear) the nickname of every member.
 * - Lock nicknames    : if anyone changes a locked nickname, the bot reverts it.
 * - Set one nickname  : set a single member's nickname.
 *
 * Locks are saved to gc-state.json so they survive restarts
 * (on Render free the disk is wiped on redeploy, locks reset then).
 */

const fs = require("fs");
const path = require("path");

const STATE_FILE =
  process.env.BANAT_GC_STATE_FILE ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "gc-state.json")
    : path.join(process.cwd(), "gc-state.json"));

const state = { names: {}, nicks: {} };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  state.names = saved.names || {};
  state.nicks = saved.nicks || {};
} catch (_) {}

function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.warn("[GC] could not save state:", e?.message || e); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls api[method](...args, cb) and also understands promise-returning versions.
function call(api, method, ...args) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api[method] !== "function") {
      return reject(new Error(`api.${method} is not available in this ws3-fca version`));
    }
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), 25000);
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(res);
    };
    try {
      const r = api[method](...args, (err, res) => finish(err, res));
      if (r && typeof r.then === "function") r.then((v) => finish(null, v)).catch(finish);
    } catch (e) { finish(e); }
  });
}

async function getThreadInfo(api, threadID) {
  const info = await call(api, "getThreadInfo", String(threadID));
  return info || {};
}

async function getAdminIDs(api, threadID) {
  const info = await getThreadInfo(api, threadID);
  return (info.adminIDs || []).map((a) => String(a?.id ?? a));
}

// ---------- GC NAME LOCK ----------
async function lockName(api, threadID, name) {
  threadID = String(threadID);
  let target = String(name || "").trim();
  if (!target) {
    const info = await getThreadInfo(api, threadID);
    target = String(info.threadName || info.name || "").trim();
    if (!target) throw new Error("This GC has no name yet. Give a name to lock.");
  }
  state.names[threadID] = target;
  save();
  try { await call(api, "setTitle", target, threadID); }
  catch (e) { return { name: target, applied: false, error: String(e?.message || e) }; }
  return { name: target, applied: true };
}

function unlockName(threadID) {
  const had = Boolean(state.names[String(threadID)]);
  delete state.names[String(threadID)];
  save();
  return { had };
}

// ---------- NICKNAMES ----------
const busy = new Set();

async function withBusy(threadID, fn) {
  const key = String(threadID);
  if (busy.has(key)) throw new Error("Nickname job already running in this GC. Wait for it to finish.");
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

// nickname = "" clears everyone's nickname (and removes the nickname lock).
async function setAllNicknames(api, threadID, nickname, { lock = false } = {}) {
  threadID = String(threadID);
  nickname = String(nickname ?? "").trim();
  return withBusy(threadID, async () => {
    const info = await getThreadInfo(api, threadID);
    const ids = (info.participantIDs || []).map(String);
    if (!ids.length) throw new Error("Could not read the member list of this GC.");

    if (!nickname) {
      delete state.nicks[threadID];
    } else if (lock) {
      state.nicks[threadID] = Object.fromEntries(ids.map((id) => [id, nickname]));
    }
    save();

    let ok = 0, failed = 0;
    for (const id of ids) {
      try { await call(api, "changeNickname", nickname, threadID, id); ok++; }
      catch (e) { failed++; console.warn(`[GC] nickname failed for ${id}:`, e?.message || e); }
      await sleep(700 + Math.random() * 800); // go slow, avoid Facebook rate limits
    }
    return { total: ids.length, ok, failed, locked: Boolean(lock && nickname) };
  });
}

async function setOneNickname(api, threadID, userID, nickname, { lock = false } = {}) {
  threadID = String(threadID); userID = String(userID);
  nickname = String(nickname ?? "").trim();
  await call(api, "changeNickname", nickname, threadID, userID);
  if (lock && nickname) {
    state.nicks[threadID] = Object.assign(state.nicks[threadID] || {}, { [userID]: nickname });
    save();
  } else if (state.nicks[threadID]) {
    delete state.nicks[threadID][userID];
    if (!Object.keys(state.nicks[threadID]).length) delete state.nicks[threadID];
    save();
  }
  return { userID, nickname };
}

// Lock whatever nicknames the GC has right now.
async function lockNicknames(api, threadID) {
  threadID = String(threadID);
  const info = await getThreadInfo(api, threadID);
  const current = {};
  for (const [id, nick] of Object.entries(info.nicknames || {})) {
    if (nick) current[String(id)] = String(nick);
  }
  if (!Object.keys(current).length) throw new Error("No nicknames set in this GC yet. Use nickall first.");
  state.nicks[threadID] = current;
  save();
  return { count: Object.keys(current).length };
}

function unlockNicknames(threadID) {
  const had = Boolean(state.nicks[String(threadID)]);
  delete state.nicks[String(threadID)];
  save();
  return { had };
}

// ---------- AUTO-REVERT (called for every non-message event) ----------
const revertLog = new Map(); // threadID -> [timestamps]
const pausedUntil = new Map();

function allowRevert(threadID) {
  const now = Date.now();
  if ((pausedUntil.get(threadID) || 0) > now) return false;
  const list = (revertLog.get(threadID) || []).filter((t) => now - t < 30000);
  list.push(now);
  revertLog.set(threadID, list);
  if (list.length > 10) { // someone is fighting the lock; back off so FB does not flag us
    pausedUntil.set(threadID, now + 60000);
    console.warn(`[GC] too many reverts in ${threadID}, pausing locks for 60s`);
    return false;
  }
  return true;
}

function handleEvent(api, event, botID) {
  if (!event || event.type !== "event") return false;
  const threadID = String(event.threadID || "");
  if (!threadID) return false;
  const author = String(event.author || "");
  if (botID && author === String(botID)) return false; // our own change

  if (event.logMessageType === "log:thread-name") {
    const locked = state.names[threadID];
    if (!locked) return false;
    if (String(event.logMessageData?.name || "") === locked) return false;
    if (!allowRevert(threadID)) return true;
    sleep(900).then(() => call(api, "setTitle", locked, threadID))
      .then(() => console.log(`[GC] name restored in ${threadID}`))
      .catch((e) => console.warn("[GC] restore name failed:", e?.message || e));
    return true;
  }

  if (event.logMessageType === "log:user-nickname") {
    const map = state.nicks[threadID];
    if (!map) return false;
    const uid = String(event.logMessageData?.participant_id || "");
    const want = map[uid];
    if (want === undefined) return false;
    if (String(event.logMessageData?.nickname || "") === want) return false;
    if (!allowRevert(threadID)) return true;
    sleep(900).then(() => call(api, "changeNickname", want, threadID, uid))
      .then(() => console.log(`[GC] nickname restored for ${uid} in ${threadID}`))
      .catch((e) => console.warn("[GC] restore nickname failed:", e?.message || e));
    return true;
  }
  return false;
}

// ---------- DASHBOARD HELPERS ----------
async function listThreads(api) {
  const list = await call(api, "getThreadList", 60, null, ["INBOX"]);
  return (list || [])
    .filter((t) => t && (t.isGroup === undefined || t.isGroup))
    .map((t) => ({ id: String(t.threadID), name: t.name || t.threadName || "(no name)" }));
}

function getState() {
  return {
    names: { ...state.names },
    nicks: Object.fromEntries(Object.entries(state.nicks).map(([t, m]) => [t, Object.keys(m).length]))
  };
}

// One entry point used by the dashboard.
async function run(api, action, p = {}) {
  const threadID = String(p.threadID || "").trim();
  if (!threadID) throw new Error("threadID is required");
  switch (action) {
    case "lock-name": {
      const r = await lockName(api, threadID, p.name);
      return { message: r.applied ? `Name locked: ${r.name}` : `Name locked (${r.name}) but rename failed: ${r.error}` };
    }
    case "unlock-name":
      unlockName(threadID);
      return { message: "Name unlocked" };
    case "nick-all":
      return { background: true, job: () => setAllNicknames(api, threadID, p.nickname, { lock: Boolean(p.lock) }), message: "Setting nicknames... this takes a while, check Activity." };
    case "nick-clear":
      return { background: true, job: () => setAllNicknames(api, threadID, "", {}), message: "Clearing nicknames... check Activity." };
    case "nick-lock": {
      const r = await lockNicknames(api, threadID);
      return { message: `Locked ${r.count} nicknames` };
    }
    case "nick-unlock":
      unlockNicknames(threadID);
      return { message: "Nicknames unlocked" };
    default:
      throw new Error("Unknown GC action");
  }
}

module.exports = {
  getAdminIDs, getThreadInfo,
  lockName, unlockName,
  setAllNicknames, setOneNickname, lockNicknames, unlockNicknames,
  handleEvent, listThreads, getState, run
};
