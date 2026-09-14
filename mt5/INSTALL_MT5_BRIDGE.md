# Instalasi MT5 Bridge V1

Bridge ini hanya mengirim data market dari MT5 ke website AI Trading SMC. Versi V1 tidak membuka, mengubah, atau menutup posisi.

## 1. Pasang file EA

Salin `AI_Trading_SMC_Bridge.mq5` ke folder MetaTrader 5:

`MQL5/Experts/AI_Trading_SMC_Bridge.mq5`

Buka MetaEditor lalu Compile.

## 2. Izinkan WebRequest

Di MT5 buka:

`Tools > Options > Expert Advisors`

Centang `Allow WebRequest for listed URL`, lalu tambahkan:

`https://ai-trading-smc-production.up.railway.app`

## 3. Jalankan EA

Pasang EA pada chart XAUUSD. Bridge akan mengirim candle terakhir yang sudah close untuk M3, M5, dan M15 setiap 5 detik, bersama bid/ask saat ini.

Jika broker menggunakan suffix seperti `XAUUSDm`, backend akan menormalkannya menjadi `XAUUSD`.

## 4. Verifikasi koneksi

Buka endpoint berikut di browser:

`https://ai-trading-smc-production.up.railway.app/api/mt5/status`

Jika bridge aktif, `connected` akan menjadi `true` dan data M3/M5/M15 akan terlihat.

## Keamanan

Backend mendukung header `X-Bridge-Token` melalui environment variable `MT5_BRIDGE_TOKEN`. Token dapat diaktifkan setelah uji koneksi dasar berhasil.

## Auto trade

Auto trade sengaja dinonaktifkan pada V1. Endpoint `/api/orders/pending` selalu mengembalikan `executionEnabled: false` dan tidak ada order yang dikirim ke MT5.
