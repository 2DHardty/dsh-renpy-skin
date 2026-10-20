@echo off
REM Launch DeepSeek Harness with a DevTools debugging port and permissive autoplay.
REM
REM Why these three switches:
REM   --remote-debugging-port=9222        Chromium's CDP endpoint, so an external
REM                                       DevTools / Playwright / CDP client can
REM                                       attach to the renderer.
REM   --remote-allow-origins=*            CDP rejects WebSocket clients whose
REM                                       Origin it does not recognise; without
REM                                       this, a browser-based DevTools page is
REM                                       refused.
REM   --autoplay-policy=no-user-gesture-required
REM                                       Media may start without a click, which
REM                                       is what the skin's splash and menu
REM                                       music need at startup.
REM
REM Electron only reads these from the real command line, and DSH takes a
REM single-instance lock, so an already running copy must be fully quit first
REM or this launch is silently routed to the existing window.

setlocal
set "DSH=D:\Program\DeepSeek Harness\DeepSeek Harness.exe"
if not exist "%DSH%" (
  echo DeepSeek Harness not found at "%DSH%"
  exit /b 1
)

tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo Quitting the running DeepSeek Harness first ^(single-instance lock^)...
  taskkill /IM "DeepSeek Harness.exe" /T /F >nul 2>&1
  timeout /t 3 /nobreak >nul
)

echo DevTools endpoint: http://127.0.0.1:9222/json
start "" "%DSH%" --remote-debugging-port=9222 --remote-allow-origins=* --autoplay-policy=no-user-gesture-required
