@echo off
rem Registra el enlace hubvision-emulador:// para que HubVision pueda abrir el programa del emulador
rem al pulsar "Conectar" o "Iniciar deteccion". Solo afecta a tu usuario (no pide administrador).
rem Para quitarlo: tools\quitar-conexion.bat
setlocal

set "PYW="
for /f "delims=" %%P in ('where pythonw 2^>nul') do (
  set "PYW=%%P"
  goto :found
)
echo No se encontro pythonw.exe. Instala Python o agrega su carpeta al PATH y vuelve a intentarlo.
pause
exit /b 1

:found
set "SCRIPT=%~dp0emulador_mjpeg.py"
reg add "HKCU\Software\Classes\hubvision-emulador" /ve /d "URL:HubVision emulador" /f >nul
reg add "HKCU\Software\Classes\hubvision-emulador" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\hubvision-emulador\shell\open\command" /ve /d "\"%PYW%\" -I \"%SCRIPT%\"" /f >nul

echo.
echo Listo. Ahora HubVision puede abrir el programa del emulador al pulsar Conectar.
echo La primera vez, el navegador preguntara si permite abrirlo: marca la opcion de recordar y acepta.
echo.
pause
