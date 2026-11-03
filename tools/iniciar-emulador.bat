@echo off
rem Sirve la pantalla del emulador LDPlayer como video en http://127.0.0.1:8090/video
python "%~dp0emulador_mjpeg.py" %*
pause
