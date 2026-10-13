@echo off
rem Register the Camic DirectShow filters (run as Administrator).
rem Usage: register.bat [path\to\CamicFilters.dll]
setlocal
set DLL=%~1
if "%DLL%"=="" set DLL=%~dp0Release\CamicFilters.dll

if not exist "%DLL%" (
  echo CamicFilters.dll not found: "%DLL%"
  echo Build it first, or pass the path:  register.bat C:\path\CamicFilters.dll
  exit /b 1
)

echo Registering "%DLL%" ...
regsvr32 /s "%DLL%"
if %errorlevel% neq 0 (
  echo FAILED to register. Run this prompt as Administrator.
  exit /b 1
)
echo Done. "Camic Camera" and "Camic Microphone" now appear as devices.
endlocal
