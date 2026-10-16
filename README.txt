RENDER SETUP
1. Upload all files to a PRIVATE GitHub repo, create a Web Service on Render (render.yaml included).
2. Env vars: FB_COOKIES (your cookie), BANAT_ADMIN_IDS (your FB id, or *), CELESTIAL_DASHBOARD_API_KEY (new password).
3. Make a free UptimeRobot monitor on https://YOUR-APP.onrender.com/health every 5 min.

OPTIONAL TUNING (env vars)
BANAT_THREAD_COOLDOWN_MS=2500   min gap between replies in a GC
BANAT_GLOBAL_SEND_LIMIT=3       GCs replying at the same time
BANAT_HOURLY_CAP=150            max replies per GC per hour
BANAT_MAX_CPS=28                typing speed
