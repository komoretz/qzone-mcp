@echo off
rem 用调试端口启动 Edge（独立用户目录，避免与已有 Edge 冲突）
set EDGE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set PROFILE=%~dp0edge-profile
start "" %EDGE% --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
echo Edge 已用调试端口 9222 启动。
echo 请在 Edge 里登录 QQ 空间，然后就可以使用 qzone-mcp 了。
echo 注意：需先关闭所有 Edge 窗口再运行此脚本。
