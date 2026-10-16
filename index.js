"use strict";

/*
 * BANAT-ONLY MESSENGER BOT
 * ------------------------
 * No AI. No games. No economy. No RPG. No music. No database.
 *
 * ACTIVATION:
 *   Send: !banat on
 *
 * OTHER COMMANDS:
 *   !banat off
 *   !banat toggle
 *   !banat status
 *   !banat help
 *   !banat patayan on|off  savage roast mode
 *
 * GC COMMANDS (GC admins, or IDs listed in BANAT_ADMIN_IDS; "*" = everyone):
 *   !banat lockname [name]     lock the GC name (empty = lock current name)
 *   !banat unlockname
 *   !banat nickall <nickname>  set everyone's nickname
 *   !banat nickall! <nickname> same, and lock it (auto-revert)
 *   !banat nickclear           remove everyone's nickname
 *   !banat nick @user <name>   set one nickname (or reply to someone's message)
 *   !banat nicklock / nickunlock   lock/unlock the nicknames currently in the GC
 *   !banat gc                  show locks
 *
 * After "!banat on", Banat stays active for that thread until "!banat off".
 * BANAT_DEFAULT_ON=true can be used to start every thread in active mode.
 *
 * CELESTIAL dashboard: open the Render URL "/" and paste the cookie there.
 */

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const gc = require("./gc-controls");
const { setPatayan, isPatayan, listPatayan } = require("./banat-patayan");

// Dashboard password (used if no env var is set on the host).
// WARNING: anyone who can read this file can control the bot. Keep the repo PRIVATE.
const DASHBOARD_KEY = "celestial-oFlho12ZwZ2kR8xyOJfe12fb";
if (!process.env.ECLIPSE_DASHBOARD_API_KEY && !process.env.CELESTIAL_DASHBOARD_API_KEY) {
  process.env.ECLIPSE_DASHBOARD_API_KEY = DASHBOARD_KEY;
}

// Railway: if a Volume is attached, keep the cookie there so it survives redeploys.
if (!process.env.CELESTIAL_SESSION_FILE && process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  process.env.CELESTIAL_SESSION_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "appstate.json");
}

const PORT = Number(process.env.PORT || 10000);
const DEFAULT_ON = /^(1|true|yes|on)$/i.test(process.env.BANAT_DEFAULT_ON || "false");
const GLOBAL_SEND_LIMIT = Math.max(1, Number(process.env.BANAT_GLOBAL_SEND_LIMIT || 3));
const THREAD_COOLDOWN_MS = Math.max(0, Number(process.env.BANAT_THREAD_COOLDOWN_MS || 2500));
const HOURLY_CAP = Math.max(10, Number(process.env.BANAT_HOURLY_CAP || 150)); // max replies per GC per hour
const threadSendLog = new Map();
const RETRY_DELAYS = [1000, 3000, 6000];

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();
let globalActive = 0;
let botUserID = "";
let botPaused = false;
let messengerConnected = false;
let loginError = null;
let lastConnectedAt = null;
let lastDisconnectedAt = null;

// --- dashboard / session control state ---
let currentApi = null;
let stopListener = null;
let loginInProgress = false;
let loginGen = 0;               // bumps on every (re)login/disconnect so stale callbacks are ignored
let sessionOverride = null;     // cookie pasted from the dashboard
let lastError = null;
let lastMessageAt = null;
const stats = { received: 0, sent: 0, commands: 0, errors: 0 };
const events = [];

function pushEvent(type, message) {
  events.unshift({ type, message, at: new Date().toISOString() });
  if (events.length > 100) events.length = 100;
}

function noteError(where, error) {
  stats.errors++;
  lastError = { where, message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() };
  pushEvent("error", `${where}: ${lastError.message}`);
}

// --- watchdog / auto-recovery state ---
const MAX_RECONNECTS = Math.max(1, Number(process.env.BANAT_MAX_RECONNECTS || 10));
const PROBE_INTERVAL_MS = Math.max(60000, Number(process.env.BANAT_PROBE_INTERVAL_MS || 5 * 60 * 1000));
const MEMORY_LIMIT_MB = Math.max(150, Number(process.env.BANAT_MEMORY_LIMIT_MB || 450));
const LOGIN_TIMEOUT_MS = 60000;
const RETRY_AFTER_GIVE_UP_MS = 30 * 60 * 1000;
let manualStop = false;         // true only when YOU press Disconnect on the dashboard
let reconnectTimer = null;
let reconnectAttempts = 0;
let nextRetryAt = null;
let loginTimer = null;
let probeFailures = 0;
let lastProbeAt = null;
let lastProbeOk = null;
let offlineSince = Date.now();
let lastSoftRecycle = 0;

// Never let a stray error kill the process.
process.on("uncaughtException", (error) => {
  console.error("[BANAT] uncaughtException:", error);
  noteError("uncaught", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[BANAT] unhandledRejection:", error);
  noteError("unhandled", error);
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[BANAT] ${sig} received, shutting down`);
    manualStop = true;
    try { disconnectBot(); } catch (_) {}
    setTimeout(() => process.exit(0), 300);
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function parseMaybeJson(text) {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch (_) { return trimmed; }
}

function readSession() {
  // 1) cookie pasted on the dashboard (this run)
  if (sessionOverride) return parseMaybeJson(sessionOverride);

  // 2) cookie saved by the dashboard (survives restarts if disk is persistent)
  const candidates = [
    process.env.CELESTIAL_SESSION_FILE,
    path.join(process.cwd(), "appstate.json"),
    path.join(process.cwd(), "cookies.json")
  ].filter(Boolean);
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) return parseMaybeJson(fs.readFileSync(filePath, "utf8"));
  }

  // 3) Render environment variables
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;
  if (raw) return parseMaybeJson(raw);

  throw new Error(
    "No Facebook session found. Paste a cookie in the CELESTIAL dashboard."
  );
}

function normalizeSession(value) {
  // ws3-fca 2.0.1 expects the saved Facebook session as a cookie string,
  // not { appState: [...] }. Convert exported cookie/appstate JSON into
  // the header format that version accepts.
  if (typeof value === "string") {
    const cookie = value.trim();
    if (!cookie) throw new Error("Facebook cookie session is empty.");
    return cookie;
  }

  const entries =
    Array.isArray(value) ? value :
    Array.isArray(value?.appState) ? value.appState :
    Array.isArray(value?.cookies) ? value.cookies :
    null;

  if (!entries) {
    throw new Error(
      "Facebook session must be a cookie string or a JSON array of cookie/appState entries."
    );
  }

  const parts = entries
    .map(cookie => {
      const key = cookie?.key ?? cookie?.name;
      const val = cookie?.value;
      if (key == null || val == null) return null;
      return String(key).trim() + "=" + String(val);
    })
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Facebook session contains no valid cookie entries.");
  }

  return parts.join("; ");
}

function enqueue(threadID, job) {
  const key = String(threadID);
  const current = threadQueues.get(key) || Promise.resolve();
  const next = current.catch(() => {}).then(job).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key);
  });
  threadQueues.set(key, next);
  return next;
}

async function acquireGlobalSlot() {
  while (globalActive >= GLOBAL_SEND_LIMIT) await sleep(150);
  globalActive++;
}

function releaseGlobalSlot() { globalActive = Math.max(0, globalActive - 1); }

function is1545012(error) {
  const text = JSON.stringify(error || "");
  return /1545012|temporarily unavailable|message could not be sent/i.test(text);
}

function trafficSendMessage(api, message, threadID, callback, replyToMessageID = null) {
  const key = String(threadID);
  return enqueue(key, async () => {
    const now = Date.now();
    const cooldownUntil = Number(threadCooldown.get(key) || 0);
    if (cooldownUntil > now) {
      callback(new Error(`thread cooldown active for ${cooldownUntil - now}ms`));
      return;
    }

    const recent = (threadSendLog.get(key) || []).filter(t => now - t < 3600000);
    if (recent.length >= HOURLY_CAP) {
      threadSendLog.set(key, recent);
      callback(new Error(`hourly cap (${HOURLY_CAP}) reached for thread`));
      return;
    }

    // cooldown + small random jitter so replies are never evenly spaced
    const wait = THREAD_COOLDOWN_MS + Math.random() * 700;
    const sinceLast = now - Number(threadLastSent.get(key) || 0);
    if (sinceLast < wait) await sleep(wait - sinceLast);

    await acquireGlobalSlot();
    try {
      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const result = await new Promise((resolve, reject) => {
            let settled = false;
            const done = (err, info) => {
              if (settled) return;
              settled = true;
              err ? reject(err) : resolve(info);
            };
            try {
              let returned;
              if (replyToMessageID) returned = api.sendMessage(message, threadID, done, replyToMessageID);
              else returned = api.sendMessage(message, threadID, done);
              if (returned && typeof returned.then === "function") returned.then(info => done(null, info)).catch(done);
            } catch (e) { reject(e); }
          });
          threadLastSent.set(key, Date.now());
          recent.push(Date.now());
          threadSendLog.set(key, recent);
          callback(null, result);
          return;
        } catch (error) {
          lastErr = error;
          if (!is1545012(error) || attempt >= RETRY_DELAYS.length) break;
          threadCooldown.set(key, Date.now() + Math.min(15000, RETRY_DELAYS[attempt]));
          await sleep(RETRY_DELAYS[attempt]);
          threadCooldown.delete(key);
        }
      }
      if (is1545012(lastErr)) threadCooldown.set(key, Date.now() + 5 * 60 * 1000);
      callback(lastErr);
    } finally {
      releaseGlobalSlot();
    }
  });
}

function isBanatCommand(body) {
  return /^!banat(?:\s|$)/i.test(String(body || "").trim());
}

function commandSendMessage(api, message, threadID, replyToMessageID = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(info);
    };

    try {
      const returned = replyToMessageID
        ? api.sendMessage(message, threadID, done, replyToMessageID)
        : api.sendMessage(message, threadID, done);

      if (returned && typeof returned.then === "function") {
        returned.then(info => done(null, info)).catch(done);
      }
    } catch (error) {
      done(error);
    }
  });
}

function sendCommandReply(api, event, message) {
  const threadID = String(event.threadID);
  commandSendMessage(api, message, threadID, event.messageID || null)
    .then(() => { stats.sent++; console.log(`[BANAT] command reply sent: ${message}`); })
    .catch(error => { noteError("command reply", error); console.error("[BANAT] command reply failed:", error?.message || error); });
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const parts = String(body).trim().split(/\s+/);
  const sub = (parts[1] || "status").toLowerCase();

  if (sub === "on" || sub === "enable" || sub === "start") {
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
    console.log(`[BANAT] activated thread ${threadID} by ${event.senderID || "unknown"}`);
    sendCommandReply(api, event, "banat is on. say whatever u want 😭");
    return true;
  }

  if (sub === "off" || sub === "disable" || sub === "stop") {
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    console.log(`[BANAT] deactivated thread ${threadID}`);
    sendCommandReply(api, event, "banat off. peace 😭");
    return true;
  }

  if (sub === "toggle") {
    const next = !isBanatConversationModeActive(threadID);
    setBanatConversationMode(threadID, next, event.senderID);
    if (next) activeThreads.add(threadID);
    else activeThreads.delete(threadID);
    console.log(`[BANAT] toggled thread ${threadID}: ${next ? "ON" : "OFF"}`);
    sendCommandReply(api, event, next ? "banat is on 😭" : "banat is off");
    return true;
  }

  if (sub === "status") {
    const on = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
    sendCommandReply(api, event, on ? "banat: ON 🟢" : "banat: OFF 🔴");
    return true;
  }

  if (sub === "patayan") {
    const arg = (parts[2] || "toggle").toLowerCase();
    const next = arg === "on" ? true : arg === "off" ? false : arg === "status" ? isPatayan(threadID) : !isPatayan(threadID);
    if (arg !== "status") {
      setPatayan(threadID, next);
      if (next) { setBanatConversationMode(threadID, true, event.senderID); activeThreads.add(threadID); }
    }
    sendCommandReply(api, event, arg === "status" ? (next ? "patayan: ON 💀" : "patayan: OFF") : next ? "PATAYAN MODE ON 💀 walang awa na 'to" : "patayan off. tahimik na");
    return true;
  }

  if (sub === "help") {
    sendCommandReply(api, event, "!banat on/off/toggle/status · GC: lockname [name] · unlockname · nickall <nick> · nickall! <nick> · nickclear · nick @user <nick> · nicklock · nickunlock · gc · patayan on/off");
    return true;
  }

  if (GC_SUBS.has(sub)) {
    runGcCommand(api, event, sub, body).catch(error => {
      noteError("gc command", error);
      sendCommandReply(api, event, `di gumana: ${String(error?.message || error).slice(0, 150)}`);
    });
    return true;
  }

  sendCommandReply(api, event, "unknown banat command. use !banat help");
  return true;
}

// ---------- GC commands ----------
const GC_SUBS = new Set(["lockname", "unlockname", "nickall", "nickall!", "nickclear", "nick", "nicklock", "nickunlock", "gc"]);
const ADMIN_IDS = String(process.env.BANAT_ADMIN_IDS || "").split(/[,\s]+/).filter(Boolean);

async function isGcAdmin(api, event) {
  const id = String(event.senderID || "");
  if (ADMIN_IDS.includes("*") || ADMIN_IDS.includes(id)) return true;
  try { return (await gc.getAdminIDs(api, event.threadID)).includes(id); }
  catch (_) { return false; }
}

async function runGcCommand(api, event, sub, body) {
  if (event.isGroup === false) return sendCommandReply(api, event, "sa GC lang to 😭");
  if (!(await isGcAdmin(api, event))) return sendCommandReply(api, event, "GC admin lang pwede nito 😭");

  const threadID = String(event.threadID);
  const rest = String(body).trim().replace(/^!banat\s+\S+\s*/i, "").trim();

  if (sub === "lockname") {
    const r = await gc.lockName(api, threadID, rest);
    return sendCommandReply(api, event, r.applied ? `GC name locked: ${r.name} 🔒` : `locked "${r.name}" pero di ko mapalitan ngayon: ${String(r.error).slice(0, 80)}`);
  }
  if (sub === "unlockname") {
    gc.unlockName(threadID);
    return sendCommandReply(api, event, "GC name unlocked 🔓");
  }
  if (sub === "nickall" || sub === "nickall!") {
    if (!rest) return sendCommandReply(api, event, "usage: !banat nickall <nickname>  (or nickall! para naka-lock)");
    sendCommandReply(api, event, "sige, nilalagay ko na. matagal 'to, wait lang 😭");
    const r = await gc.setAllNicknames(api, threadID, rest, { lock: sub === "nickall!" });
    pushEvent("gc", `nickall ${threadID}: ${r.ok}/${r.total}`);
    return sendCommandReply(api, event, `done ${r.ok}/${r.total} nickname${r.locked ? " (locked 🔒)" : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
  }
  if (sub === "nickclear") {
    sendCommandReply(api, event, "binubura ko na lahat ng nickname...");
    const r = await gc.setAllNicknames(api, threadID, "", {});
    pushEvent("gc", `nickclear ${threadID}: ${r.ok}/${r.total}`);
    return sendCommandReply(api, event, `cleared ${r.ok}/${r.total}`);
  }
  if (sub === "nick") {
    const mentions = event.mentions && typeof event.mentions === "object" ? event.mentions : {};
    const mentionIDs = Object.keys(mentions);
    let name = rest;
    for (const label of Object.values(mentions)) name = name.split(String(label)).join("");
    name = name.trim();
    const targetID = mentionIDs[0] || event.messageReply?.senderID || event.senderID;
    if (!name) return sendCommandReply(api, event, "usage: !banat nick @user <nickname>  (or reply sa message nila)");
    await gc.setOneNickname(api, threadID, targetID, name, { lock: false });
    return sendCommandReply(api, event, "nickname set ✅");
  }
  if (sub === "nicklock") {
    const r = await gc.lockNicknames(api, threadID);
    return sendCommandReply(api, event, `${r.count} nickname locked 🔒`);
  }
  if (sub === "nickunlock") {
    gc.unlockNicknames(threadID);
    return sendCommandReply(api, event, "nicknames unlocked 🔓");
  }
  if (sub === "gc") {
    const st = gc.getState();
    const name = st.names[threadID];
    const nicks = st.nicks[threadID];
    return sendCommandReply(api, event, `name lock: ${name ? `ON (${name})` : "OFF"} · nickname lock: ${nicks ? `ON (${nicks})` : "OFF"}`);
  }
}

async function sendBanat(api, event, text) {
  try {
    const result = await sendBanatReplyWithTyping(api, text, String(event.threadID), event.messageID || null, {
      trafficSendMessage,
      incomingText: event.body || ""
    });
    stats.sent++;
    pushEvent("reply", `thread ${event.threadID}: ${String(text).slice(0, 60)}`);
    return result;
  } catch (error) {
    noteError("reply", error);
    throw error;
  }
}

function onMessage(api, event) {
  if (!event) return;
  if (event.type && event.type !== "message" && event.type !== "message_reply") return;
  if (botPaused) return;
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;

  stats.received++;
  lastMessageAt = new Date().toISOString();
  pushEvent("message", `thread ${event.threadID} · ${event.senderID || "?"}: ${body.slice(0, 60)}`);

  if (isBanatCommand(body)) { stats.commands++; handleBanatCommand(api, event, body); return; }

  const threadID = String(event.threadID);
  const active = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
  const target = classifyBanatTarget({ event, body, eclipseUserID: botUserID });

  if (active) {
    console.log(`[BANAT] active message in ${threadID} from ${event.senderID || "unknown"}`);
    const reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
    if (reply) {
      sendBanat(api, event, reply).catch(error => console.error("[BANAT] reply error:", error));
    } else {
      console.warn(`[BANAT] no reply generated for active message in ${threadID}`);
    }
    return;
  }

  if (target.shouldRespond) {
    const reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
    if (reply) sendBanat(api, event, reply).catch(error => console.error("[BANAT]", error));
  }
}

function start(api, gen) {
  currentApi = api;
  offlineSince = null;
  probeFailures = 0;
  messengerConnected = true;
  loginError = null;
  lastConnectedAt = new Date().toISOString();
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}

  if (DEFAULT_ON) console.log("[BANAT] BANAT_DEFAULT_ON enabled.");

  try { api.setOptions?.({ listenEvents: true, selfListen: false }); } catch (_) {}

  const stop = api.listenMqtt((error, event) => {
    if (gen !== loginGen) return; // stale listener from an old session
    if (error) {
      noteError("listener", error);
      console.error("[BANAT] listener error:", error);
      const text = JSON.stringify(error?.message || error || "");
      if (/not logged in|checkpoint|login approval|session.*(expired|invalid)|invalid.*session|authentication/i.test(text)) {
        loginError = String(error?.message || error);
        disconnectBot();
        scheduleReconnect("session error");
      }
      return;
    }
    try {
      if (event?.type === "event") {
        if (!botPaused) gc.handleEvent(api, event, botUserID);
        return;
      }
      if (DEFAULT_ON && event?.threadID && event?.senderID && String(event.senderID) !== botUserID) {
        const key = String(event.threadID);
        if (!activeThreads.has(key)) {
          activeThreads.add(key);
          setBanatConversationMode(key, true, event.senderID);
        }
      }
      onMessage(api, event);
    } catch (e) {
      noteError("message handler", e);
      console.error("[BANAT] message handler error:", e);
    }
  });

  stopListener = typeof stop === "function"
    ? stop
    : (typeof api.stopListening === "function" ? () => api.stopListening() : null);

  console.log(`[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`);
}

// Stops the bot locally. Does NOT call api.logout(), so the Facebook cookie stays valid.
function disconnectBot() {
  loginGen++;
  clearTimeout(loginTimer);
  loginTimer = null;
  try { if (stopListener) stopListener(); } catch (_) {}
  stopListener = null;
  currentApi = null;
  if (messengerConnected) lastDisconnectedAt = new Date().toISOString();
  messengerConnected = false;
  loginInProgress = false;
  offlineSince = offlineSince || Date.now();
  console.log("[BANAT] disconnected");
}

function resetRetry() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
  nextRetryAt = null;
}

// Auto-reconnect with exponential backoff: 5s, 10s, 20s ... up to 5 min.
function scheduleReconnect(reason) {
  if (manualStop || reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECTS) {
    pushEvent("watchdog", `Gave up after ${MAX_RECONNECTS} tries. Will retry in 30 min, or paste a fresh cookie.`);
    return;
  }
  const delay = Math.min(300000, 5000 * 2 ** reconnectAttempts);
  reconnectAttempts++;
  nextRetryAt = new Date(Date.now() + delay).toISOString();
  pushEvent("watchdog", `${reason} -> reconnect #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
  console.log(`[BANAT] ${reason}; reconnect #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    nextRetryAt = null;
    if (manualStop) return;
    disconnectBot();
    loginBot();
  }, delay);
}

function loginBot() {
  const gen = ++loginGen;
  let cookie;
  try {
    cookie = normalizeSession(readSession());
  } catch (error) {
    messengerConnected = false;
    loginInProgress = false;
    loginError = String(error?.message || error);
    console.error("[BANAT] no usable session:", loginError);
    return; // nothing to retry until a cookie is pasted
  }

  loginInProgress = true;
  loginError = null;
  console.log("[BANAT] logging in with saved Facebook session...");
  console.log(`[BANAT] session format: cookie string (${cookie.length} chars)`);

  // If login hangs, give up on this attempt and retry.
  clearTimeout(loginTimer);
  loginTimer = setTimeout(() => {
    if (gen !== loginGen || !loginInProgress) return;
    loginGen++;
    loginInProgress = false;
    loginError = "login timed out";
    noteError("login", "timed out");
    scheduleReconnect("login timeout");
  }, LOGIN_TIMEOUT_MS);

  try {
    login(cookie, (error, api) => {
      if (gen !== loginGen) return; // superseded by a newer login/disconnect
      clearTimeout(loginTimer);
      loginInProgress = false;
      if (error) {
        messengerConnected = false;
        loginError = String(error?.message || error);
        noteError("login", error);
        console.error("[BANAT] login failed:", error);
        scheduleReconnect("login failed");
        return;
      }
      start(api, gen);
    });
  } catch (error) {
    clearTimeout(loginTimer);
    loginInProgress = false;
    loginError = String(error?.message || error);
    noteError("login", error);
    scheduleReconnect("login error");
  }
}

// Light "are you still logged in?" check every few minutes.
function probe() {
  if (!messengerConnected || !currentApi || manualStop) return;
  const api = currentApi;
  const gen = loginGen;
  if (typeof api.getUserInfo !== "function" || !botUserID) return;

  let done = false;
  let timer = null;
  const finish = (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (gen !== loginGen) return;
    lastProbeAt = new Date().toISOString();
    if (!err) {
      probeFailures = 0;
      lastProbeOk = true;
      reconnectAttempts = 0;
      return;
    }
    lastProbeOk = false;
    probeFailures++;
    noteError("watchdog probe", err);
    if (probeFailures >= 3) {
      probeFailures = 0;
      pushEvent("watchdog", "Probe failed 3 times, restarting connection");
      disconnectBot();
      scheduleReconnect("probe failed");
    }
  };

  timer = setTimeout(() => finish(new Error("probe timeout")), 30000);
  try {
    const r = api.getUserInfo(botUserID, (err) => finish(err || null));
    if (r && typeof r.then === "function") r.then(() => finish(null)).catch(finish);
  } catch (e) {
    finish(e);
  }
}

function hasSession() {
  try { normalizeSession(readSession()); return true; } catch (_) { return false; }
}

// Memory guard + "stuck offline" guard, once a minute.
function guard() {
  const mb = process.memoryUsage().rss / 1048576;
  if (mb > MEMORY_LIMIT_MB) {
    // Soft recovery first (keeps the process + Render instance alive), hard restart only as last resort.
    if (mb > MEMORY_LIMIT_MB * 1.2) {
      console.error(`[BANAT] memory ${Math.round(mb)}MB way over limit, restarting process`);
      pushEvent("watchdog", `Memory ${Math.round(mb)}MB too high, restarting process`);
      setTimeout(() => process.exit(1), 500); // host restarts it automatically
      return;
    }
    if (messengerConnected && !manualStop && Date.now() - lastSoftRecycle > 10 * 60 * 1000) {
      lastSoftRecycle = Date.now();
      pushEvent("watchdog", `Memory ${Math.round(mb)}MB high, recycling connection`);
      disconnectBot();
      scheduleReconnect("memory recycle");
    }
    try { if (global.gc) global.gc(); } catch (_) {}
  }
  if (
    !messengerConnected && !loginInProgress && !manualStop && !reconnectTimer &&
    reconnectAttempts >= MAX_RECONNECTS && offlineSince &&
    Date.now() - offlineSince > RETRY_AFTER_GIVE_UP_MS && hasSession()
  ) {
    reconnectAttempts = 0;
    offlineSince = Date.now();
    scheduleReconnect("periodic retry");
  }
}

function threadsInCooldown() {
  const now = Date.now();
  let n = 0;
  for (const until of threadCooldown.values()) if (Number(until) > now) n++;
  return n;
}

try {
  require("./dashboard-api")(PORT, () => ({
    ok: true,
    facebook_connected: messengerConnected,
    facebook_user_id: botUserID || null,
    facebook_user_name: null,
    session_active: messengerConnected,
    bot_running: messengerConnected && !botPaused,
    paused: botPaused,
    login_in_progress: loginInProgress,
    login_error: loginError,
    last_error: lastError,
    last_connected_at: lastConnectedAt,
    last_disconnected_at: lastDisconnectedAt,
    last_message_at: lastMessageAt,
    messages_received: stats.received,
    replies_sent: stats.sent,
    commands_used: stats.commands,
    errors: stats.errors,
    active_threads: activeThreads.size,
    threads_in_cooldown: threadsInCooldown(),
    default_on: DEFAULT_ON,
    global_send_limit: GLOBAL_SEND_LIMIT,
    thread_cooldown_ms: THREAD_COOLDOWN_MS,
    auto_reconnect: !manualStop,
    reconnect_attempts: reconnectAttempts,
    next_retry_at: nextRetryAt,
    watchdog_gave_up: reconnectAttempts >= MAX_RECONNECTS && !messengerConnected,
    probe_failures: probeFailures,
    last_probe_ok: lastProbeOk,
    last_probe_at: lastProbeAt,
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    memory_limit_mb: MEMORY_LIMIT_MB,
    keepalive_url: KEEPALIVE_URL || null,
    last_keepalive: lastKeepAlive,
    updated_at: new Date().toISOString()
  }), {
    setPaused: (paused) => { botPaused = Boolean(paused); },
    getPaused: () => botPaused,
    getEvents: () => events,
    gcState: () => Object.assign(gc.getState(), { patayan: listPatayan() }),
    gcThreads: async () => {
      if (!currentApi) throw new Error("Messenger is not connected");
      return gc.listThreads(currentApi);
    },
    gcAction: async (action, params) => {
      if (action === "patayan-on" || action === "patayan-off") {
        const id = String(params.threadID || "").trim();
        if (!id) throw new Error("threadID is required");
        const on = action === "patayan-on";
        setPatayan(id, on);
        if (on) { setBanatConversationMode(id, true, "dashboard"); activeThreads.add(id); }
        pushEvent("gc", `patayan ${on ? "ON" : "OFF"} ${id}`);
        return { message: on ? "PATAYAN MODE ON 💀" : "Patayan off" };
      }
      if (!currentApi) throw new Error("Messenger is not connected");
      const r = await gc.run(currentApi, action, params);
      if (r.background) {
        const label = `${action} ${params.threadID}`;
        r.job()
          .then(x => pushEvent("gc", `${label}: ${x.ok}/${x.total} done${x.failed ? `, ${x.failed} failed` : ""}`))
          .catch(e => noteError(`gc ${action}`, e));
        return { message: r.message };
      }
      pushEvent("gc", `${action} ${params.threadID}`);
      return r;
    },
    connectSession: async (raw) => {
      sessionOverride = raw;
      manualStop = false;
      resetRetry();
      disconnectBot();
      loginBot();
    },
    reconnect: async () => {
      manualStop = false;
      resetRetry();
      disconnectBot();
      loginBot();
    },
    disconnect: async () => {
      sessionOverride = null;
      manualStop = true;
      resetRetry();
      disconnectBot();
    }
  });
} catch (error) {
  console.error("[BANAT] dashboard API failed:", error);
}

// ---------- KEEP-ALIVE (Render free sleeps after ~15 min without web traffic) ----------
// Render sets RENDER_EXTERNAL_URL automatically. We hit our own public /health every 4 min.
// Also add an external pinger (UptimeRobot / cron-job.org -> https://YOUR-APP.onrender.com/health every 5 min)
// because a service that is ALREADY asleep cannot wake itself up.
const KEEPALIVE_URL = String(
  process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/+$/, "");
const KEEPALIVE_MS = Math.max(60000, Number(process.env.BANAT_KEEPALIVE_MS || 4 * 60 * 1000));
let lastKeepAlive = null;

async function keepAlive() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(KEEPALIVE_URL + "/health", { signal: ctrl.signal, headers: { "User-Agent": "banat-keepalive" } });
    clearTimeout(t);
    lastKeepAlive = { ok: res.ok, status: res.status, at: new Date().toISOString() };
  } catch (error) {
    lastKeepAlive = { ok: false, error: String(error?.message || error).slice(0, 100), at: new Date().toISOString() };
  }
}
if (KEEPALIVE_URL && typeof fetch === "function") {
  console.log(`[BANAT] keep-alive on -> ${KEEPALIVE_URL}/health every ${Math.round(KEEPALIVE_MS / 1000)}s`);
  setInterval(keepAlive, KEEPALIVE_MS).unref();
  setTimeout(keepAlive, 30000).unref();
} else {
  console.log("[BANAT] keep-alive off (no RENDER_EXTERNAL_URL / KEEPALIVE_URL)");
}

setInterval(probe, PROBE_INTERVAL_MS).unref();
setInterval(guard, 60000).unref();

loginBot();

module.exports = { trafficSendMessage, onMessage, handleBanatCommand };
