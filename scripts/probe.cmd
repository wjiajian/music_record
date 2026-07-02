@echo off
rem 探针任务包装（退路：用任务计划器每 30min 跑单发探针，而非 --watch 自循环）。
rem 把 YOUR_UID_HERE 改成你的网易云 uid。
cd /d D:\Project\music_record
set NETEASE_UID=YOUR_UID_HERE
node --disable-warning=ExperimentalWarning src\probe\runProbe.js >> data\probe.log 2>&1
