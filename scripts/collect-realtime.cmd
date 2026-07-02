@echo off
rem 高频实时采集任务包装：只刷新今日足迹 + 最近播放。
rem NETEASE_COOKIE 建议写在项目 .env 或系统环境变量里。
cd /d D:\Project\music_record
node --disable-warning=ExperimentalWarning src\collector\runRealtime.js >> data\collect-realtime.log 2>&1
