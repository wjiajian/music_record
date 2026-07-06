@echo off
rem Daily collect wrapper (route B: uid / cookie / ATTRIBUTION all come from .env).
rem config.js auto-loads .env at startup, so do NOT `set` them here --
rem process env vars take precedence over .env and would override the real values.
cd /d D:\Project\music_record
node --disable-warning=ExperimentalWarning src\collector\runDaily.js >> data\collect.log 2>&1
