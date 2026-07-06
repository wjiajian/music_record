@echo off
rem Start the music-record API (with in-process daily collection) for local use.
rem uid / cookie / options all come from the project .env (config.js auto-loads it).
rem Do NOT `set` NETEASE_UID here -- process env vars override .env's real value.
rem Comments kept ASCII on purpose: .cmd is read as GBK/CP936 and UTF-8 breaks it.
cd /d D:\Project\music_record

echo [start-api] starting API (default http://127.0.0.1:3000, override via API_PORT in .env)
echo [start-api] daily collect runs in-process; press Ctrl+C to stop. Logs below:
node --disable-warning=ExperimentalWarning src\api\server.js
