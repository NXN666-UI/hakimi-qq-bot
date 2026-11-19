@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo 缺少本项目本地运行时：runtime\node.exe
  pause
  exit /b 1
)
if not exist "data\tmp" mkdir "data\tmp"
if not exist "data\cache" mkdir "data\cache"
set "TEMP=%~dp0data\tmp"
set "TMP=%~dp0data\tmp"
set "TMPDIR=%~dp0data\tmp"
set "XDG_CACHE_HOME=%~dp0data\cache"
set "NODE_REPL_HISTORY=%~dp0data\cache\node-repl-history"
set "NODE_COMPILE_CACHE=%~dp0data\cache\node"
set "NODE_OPTIONS="
if "%~1"=="check" goto check
if "%~1"=="models" goto models
if "%~1"=="qq" goto qq
if "%~1"=="test" goto test
"runtime\node.exe" "src\main.mjs"
goto done
:check
"runtime\node.exe" "src\main.mjs" --check
goto done
:models
"runtime\node.exe" "scripts\probe.mjs" models
goto done
:qq
"runtime\node.exe" "scripts\probe.mjs" qq
goto done
:test
"runtime\node.exe" --test --test-isolation=none "test\integration.test.mjs" "test\memory.test.mjs" "test\media.test.mjs" "test\lifecycle.test.mjs" "test\search.test.mjs" "test\impressions.test.mjs" "test\models.test.mjs" "test\web-ui.test.mjs"
:done
set "HAKIMI_EXIT=%errorlevel%"
echo.
echo 已结束。只停止此窗口中的哈基米，其他机器人不受影响。
pause
exit /b %HAKIMI_EXIT%
