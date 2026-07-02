@echo off
rem 每日采集任务包装：schtasks 不继承会话环境变量，必须在此注入。
rem 把 YOUR_UID_HERE 改成你的网易云 uid；ATTRIBUTION 用 probe:analyze 给出的建议值。
cd /d D:\Project\music_record
set NETEASE_UID=YOUR_UID_HERE
set ATTRIBUTION=prev
node --disable-warning=ExperimentalWarning src\collector\runDaily.js >> data\collect.log 2>&1
