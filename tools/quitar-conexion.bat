@echo off
rem Quita el enlace hubvision-emulador:// registrado por instalar-conexion.bat
reg delete "HKCU\Software\Classes\hubvision-emulador" /f >nul 2>&1
echo Listo. El enlace hubvision-emulador:// fue eliminado.
pause
