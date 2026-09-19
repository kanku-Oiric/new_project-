@echo off
REM ---------------------------------------------------------------------------
REM  Menyalakan sistem kasir toko.
REM
REM  Klik dua kali berkas ini, lalu JANGAN TUTUP jendelanya. Jendela ini adalah
REM  sistemnya; menutupnya sama dengan mematikan kasir.
REM
REM  Untuk mematikan: tekan Ctrl + C di jendela ini, jawab Y kalau ditanya.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"
title Kasir Toko - JANGAN TUTUP JENDELA INI

echo ==========================================================
echo   KASIR TOKO
echo ==========================================================
echo.

REM Node harus ada. Tanpa pesan ini, jendela cuma berkedip lalu tertutup dan
REM tidak ada yang tahu kenapa.
where node >nul 2>nul
if errorlevel 1 (
  echo  GAGAL: Node.js tidak ditemukan di laptop ini.
  echo.
  echo  Hubungi yang mengerjakan kodenya. Node.js perlu dipasang lebih dulu.
  echo.
  pause
  exit /b 1
)

REM .env memuat lokasi database. Tanpa berkas itu, aplikasi berhenti dengan
REM pesan yang tidak bisa dibaca orang non-teknis.
if not exist ".env" (
  echo  GAGAL: berkas .env tidak ada.
  echo.
  echo  Salin .env.example menjadi .env lebih dulu, lalu jalankan ulang.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  GAGAL: folder node_modules tidak ada.
  echo.
  echo  Jalankan "npm install" lebih dulu. Hubungi yang mengerjakan kodenya.
  echo.
  pause
  exit /b 1
)

REM Alamat untuk HP kasir, dicetak supaya tidak perlu menjalankan ipconfig.
echo  Alamat untuk HP / tablet kasir (pilih yang diawali 192.168 atau 10.):
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo      http://%%b:3000
)
echo.
echo  Di laptop ini sendiri:  http://localhost:3000
echo.
echo ----------------------------------------------------------
echo  JANGAN TUTUP JENDELA INI selama toko buka.
echo  Untuk mematikan: tekan Ctrl + C lalu jawab Y.
echo ----------------------------------------------------------
echo.

REM Migration dijalankan dulu: setelah pembaruan aplikasi, database perlu
REM disesuaikan. "migrate deploy" tidak pernah menghapus data, berbeda dari
REM "migrate dev" yang bisa mereset.
echo  Menyiapkan database...
call npx prisma migrate deploy
if errorlevel 1 (
  echo.
  echo  GAGAL menyiapkan database. Sistem TIDAK dinyalakan.
  echo  Kirim isi jendela ini ke yang mengerjakan kodenya.
  echo.
  pause
  exit /b 1
)

echo.
echo  Menyalakan sistem...
echo.

REM Mode produksi kalau sudah di-build; kalau belum, jatuh ke mode dev supaya
REM toko tetap bisa berjualan hari ini.
if exist ".next\BUILD_ID" (
  call npm run start
) else (
  echo  Catatan: aplikasi belum di-build, dijalankan dalam mode pengembangan.
  echo  Lebih lambat, tapi tetap benar. Minta di-build supaya lebih cepat.
  echo.
  call npm run dev
)

echo.
echo  Sistem berhenti. Jendela ini boleh ditutup.
pause
