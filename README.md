# Kasir Toko

Sistem kasir untuk satu toko kecil. Berjalan di satu laptop di toko; HP dan tablet kasir memakainya lewat WiFi toko.

**Bacaan ini dibagi dua.** Bagian A untuk yang menjalankan toko — tidak perlu tahu apa pun soal pemrograman. Bagian B untuk yang mengerjakan kodenya.

---

# BAGIAN A — Untuk yang menjalankan toko

## A1. Menyalakan sistem setiap pagi

1. Nyalakan laptop toko.
2. Klik dua kali **`start-toko.bat`** di folder aplikasi.
3. Sebuah jendela hitam terbuka dan menampilkan tulisan berjalan. **Jangan ditutup.** Jendela itu adalah sistemnya; menutupnya sama dengan mematikan kasir.
4. Tunggu sampai muncul tulisan yang memuat `Ready` atau `started server`.
5. Buka `http://localhost:3000` di laptop itu, atau alamat WiFi di HP kasir (lihat A3).

Kalau jendela hitamnya langsung tertutup sendiri, berarti ada yang salah. Lihat A8.

## A2. Mematikan sistem setiap malam

1. Pastikan **semua kasir sudah menutup shift**-nya. Tutup shift juga membuat backup otomatis.
2. Klik jendela hitam itu, lalu tekan **Ctrl + C**. Kalau ia bertanya, jawab `Y` lalu Enter.
3. Tutup jendelanya, lalu matikan laptop seperti biasa.

Mematikan laptop tanpa menutup shift **tidak** menghilangkan data — penjualan tersimpan saat tombol Bayar ditekan, bukan saat shift ditutup. Yang hilang hanya rekonsiliasi kas hari itu, dan shift yang masih terbuka harus ditutup besok.

## A3. Mencari alamat untuk HP kasir

HP kasir tidak bisa memakai `localhost` — itu hanya berlaku di laptop itu sendiri. HP butuh alamat WiFi laptop, yang bentuknya seperti `192.168.1.5`.

Cara mencarinya:

1. Di laptop toko, tekan tombol **Windows**, ketik `cmd`, tekan Enter.
2. Ketik perintah ini lalu Enter:

   ```
   ipconfig
   ```

3. Cari baris **`IPv4 Address`** di bagian adapter WiFi. Angkanya seperti `192.168.1.5`.
4. Di HP kasir, buka browser dan ketik alamat itu diikuti `:3000`:

   ```
   http://192.168.1.5:3000
   ```

Simpan alamat itu sebagai bookmark, atau pakai "Add to Home screen" supaya jadi seperti aplikasi.

**Angka ini bisa berubah** setelah router restart. Kalau HP kasir tiba-tiba tidak bisa membuka, ulangi langkah di atas. Untuk menghentikannya berubah, minta tolong orang yang mengerti jaringan untuk memberi laptop toko IP statis di router.

## A4. Izin Windows Firewall — hanya sekali

**Pertama kali** `start-toko.bat` dijalankan, Windows akan menanyakan izin. Kotak dialognya menyebut "Windows Defender Firewall has blocked some features".

Yang harus dilakukan:

- Centang **Private networks** (jaringan pribadi).
- **Jangan** centang Public networks.
- Klik **Allow access**.

Kalau dialognya sudah pernah ditolak, HP kasir tidak akan bisa membuka aplikasinya walau alamatnya benar. Membetulkannya:

1. Tekan Windows, ketik `Windows Defender Firewall`, Enter.
2. Klik **Allow an app or feature through Windows Defender Firewall**.
3. Cari `Node.js` di daftar, centang kolom **Private**.
4. Kalau `Node.js` tidak ada di daftar, klik **Change settings → Allow another app → Browse**, lalu pilih berkas `node.exe`.

Centang Private saja, bukan Public: sistem ini memang hanya untuk WiFi toko.

## A5. Backup — dan kenapa ini bagian terpenting di halaman ini

Sistem membuat backup **otomatis**:

- setiap kali sistem dinyalakan,
- setiap kali seorang kasir menutup shift.

Setiap backup **langsung diperiksa**: berkasnya dibuka kembali dan dihitung isinya. Halaman **Dashboard** menampilkan hasilnya. Yang perlu Anda perhatikan hanya satu kalimat di sana:

> Sudah diperiksa: berkasnya bisa dibuka dan memuat N transaksi.

Kalau yang tertulis **"GAGAL diperiksa"**, backup terakhir tidak bisa diandalkan. Tekan "Backup sekarang" di Dashboard. Kalau masih gagal, hubungi yang mengerjakan kodenya — jangan dibiarkan.

### Backup di laptop itu saja TIDAK cukup

Kalau laptopnya rusak, hilang, atau dicuri, seluruh backup di dalamnya ikut hilang. Karena itu isi satu pengaturan berikut — sekali saja, lima menit:

1. Pasang **Google Drive untuk Desktop** di laptop toko, lalu masuk dengan akun toko.
2. Buka folder aplikasi, cari berkas bernama **`.env`**.
3. Buka dengan Notepad, cari baris `BACKUP_MIRROR_DIR=`, dan lengkapi menjadi:

   ```
   BACKUP_MIRROR_DIR="G:/My Drive/Backup Toko"
   ```

   Huruf `G:` bisa berbeda di laptop Anda — lihat di File Explorer, huruf drive Google Drive ada di sana. Tanda kutip wajib kalau ada spasi.

4. Simpan, lalu matikan dan nyalakan ulang sistem (A2 lalu A1).

Setelah itu setiap backup ikut tersalin ke Google Drive dengan sendirinya. Flashdisk juga bisa (`BACKUP_MIRROR_DIR="E:/backup-toko"`), tapi flashdisk yang selalu tertancap di laptop akan hilang bersama laptopnya.

## A6. Memulihkan data setelah laptop rusak atau data kacau

Ikuti berurutan. Jangan melompat.

**Langkah 1 — Matikan sistemnya.**
Kalau jendela hitam masih terbuka, tekan Ctrl + C di jendela itu, lalu tutup. Sistem **harus** mati sebelum berkasnya disentuh.

**Langkah 2 — Siapkan berkas backup.**
Buka folder `backups/` di dalam folder aplikasi. Isinya berkas-berkas bernama seperti:

```
pos-20260920-193045.db
```

Angkanya adalah tanggal dan jam: `20260920` = 20 September 2026, `193045` = 19:30:45. **Pilih yang paling baru**, kecuali Anda tahu masalahnya sudah terjadi sebelum itu — dalam hal itu pilih yang sebelum masalahnya muncul.

Kalau laptopnya rusak total, ambil berkas itu dari folder Google Drive (A5) di komputer lain.

**Langkah 3 — Simpan dulu yang rusak, jangan langsung dihapus.**
Buka folder `data/`. Ganti nama berkas `pos.db` menjadi `pos-rusak.db`. Jangan dihapus — kalau langkah berikutnya keliru, itu satu-satunya salinan yang tersisa.

**Langkah 4 — Hapus dua berkas pendamping.** Ini langkah yang paling sering terlewat.
Di folder `data/` yang sama, hapus dua berkas ini kalau ada:

```
pos.db-wal
pos.db-shm
```

Keduanya memuat potongan penjualan **dari database yang lama**. Kalau ditinggalkan, keduanya akan ditempelkan ke database hasil pemulihan dan merusaknya kembali. Hapus keduanya.

**Langkah 5 — Pasang backup-nya.**
Salin berkas backup pilihan Anda ke folder `data/`, lalu ganti namanya menjadi tepat:

```
pos.db
```

Perhatikan: tanpa tanggal, tanpa angka. Hanya `pos.db`.

**Langkah 6 — Nyalakan dan periksa.**
Jalankan `start-toko.bat`, buka aplikasinya, lalu **periksa tiga hal** sebelum berjualan lagi:

1. Halaman **Transaksi** memuat penjualan terakhir yang Anda ingat.
2. Halaman **Produk** menampilkan harga yang benar.
3. Halaman **Dashboard** bisa dibuka tanpa pesan error.

Kalau ada yang tidak cocok, matikan lagi dan ulangi dari Langkah 2 dengan berkas backup yang lebih tua.

**Langkah 7 — Terima kenyataannya.**
Penjualan yang terjadi **setelah** waktu backup itu memang hilang dan tidak bisa dikembalikan. Kalau ada struk tercetak untuk penjualan itu, masukkan ulang manual.

> **Sekali saja, sebelum Anda benar-benar membutuhkannya:** jalankan seluruh prosedur ini sebagai latihan di hari yang tenang, memakai salinan folder aplikasi. Backup yang belum pernah berhasil dipulihkan belum bisa disebut cadangan — ia baru sebuah berkas.

## A7. Yang tidak bisa dilakukan sistem ini

Disebutkan di sini supaya tidak ada yang menunggu hal yang tidak akan datang:

- **WiFi mati = kasir berhenti.** Tidak ada mode offline. Kalau WiFi atau laptopnya mati, catat penjualan di kertas lalu masukkan setelah sistem hidup lagi. (Ini keputusan sadar, bukan kelalaian — alasannya di `docs/architecture.md` §1.)
- **QRIS tidak otomatis.** Sistem menampilkan gambar QR toko; kasir melihat notifikasi masuk di HP-nya sendiri, lalu menekan "Pembayaran diterima". Tidak ada sambungan ke bank.
- **Uang QRIS tidak bisa ditarik kembali.** Kalau transaksi QRIS yang sudah dibayar di-void, pengembalian ke pelanggan dilakukan manual. Dashboard mencatat kewajiban itu supaya tidak terlupa.
- **Tidak ada laporan pajak, kasbon, atau data pelanggan.**
- **Tidak ada printer thermal.** Struk dicetak lewat fitur cetak browser.

## A8. Kalau ada yang tidak jalan

| Yang terlihat | Yang harus dicoba |
|---|---|
| Jendela hitam langsung tertutup | Ada program lain memakai port 3000, atau berkas `.env` hilang. Lihat catatan error di `data/logs/`. |
| HP kasir: "tidak bisa terhubung" | Alamat IP berubah (A3), atau izin firewall belum diberikan (A4). Pastikan HP di WiFi yang sama, bukan data seluler. |
| Laptop bisa, HP tidak bisa | Hampir selalu firewall (A4). |
| Kasir tidak bisa checkout | Shift-nya belum dibuka. Buka halaman Shift. |
| Semua halaman error | Matikan (A2), nyalakan lagi (A1). Kalau masih, lihat `data/logs/`. |
| Laporan tidak masuk Discord/Telegram | Periksa Dashboard bagian "Pengiriman laporan". Kasir tetap bisa berjualan — laporan gagal tidak pernah menghentikan penjualan. |

Berkas log ada di folder `data/logs/`, satu berkas per hari. Kalau menghubungi yang mengerjakan kode, kirimkan berkas log hari itu.

## A9. Hal yang perlu diketahui soal keamanan

- Sistem ini berjalan di WiFi toko **tanpa enkripsi HTTPS.** Untuk WiFi tertutup milik toko, itu bisa diterima. Konsekuensinya: **beri password kuat pada WiFi toko** (WPA2 atau WPA3) dan jangan berikan passwordnya ke pelanggan. Kalau toko menyediakan WiFi untuk pelanggan, gunakan jaringan guest yang terpisah.
- PIN kasir ada 6 angka. Salah 5 kali mengunci 5 menit. Ganti PIN bawaan sebelum sistem dipakai.
- Siapa pun yang punya password WiFi toko dan tahu alamatnya bisa mencapai halaman login. Mereka masih butuh PIN, tapi jangan tempel PIN di dekat kasir.
- Berkas `.env` memuat pengaturan, dan folder `data/` memuat seluruh penjualan. Keduanya tidak boleh dibagikan.

---

# BAGIAN B — Untuk yang mengerjakan kodenya

## B1. Stack & keputusan yang mengunci

Next.js 15 (App Router) · TypeScript strict · Prisma + SQLite · Tailwind v4 · Vitest. Tanpa Docker.

Keputusan arsitektur dan alasannya ada di `docs/`:

| Dokumen | Isi |
|---|---|
| `docs/architecture.md` | Keputusan menyeluruh, alur kritis, batas yang diakui terbuka |
| `docs/database.md` | Skema, indeks, batasan Prisma+SQLite |
| `docs/reporting.md` | Definisi angka laporan, penjadwalan, catch-up |
| `docs/qris.md` | Provider pembayaran & aturan "tidak ada PAID tanpa manusia" |

Yang paling penting dibaca sebelum menyentuh apa pun: **server adalah satu-satunya sumber kebenaran** (§1), **`connection_limit=1` wajib** (§6.2), dan **setiap endpoint yang menyentuh uang wajib punya test di lapisan HTTP** (§17a).

## B2. Menyiapkan mesin baru

```bash
npm install
copy .env.example .env
npx prisma migrate deploy
npm run db:seed
npm run dev
```

`npm run dev` mengikat ke `0.0.0.0` supaya perangkat lain di LAN bisa mencapainya.

## B3. Empat pemeriksaan

```bash
npm run test && npm run typecheck && npm run lint && npm run build
```

Keempatnya harus hijau sebelum pekerjaan dianggap selesai. Tidak pernah meninggalkan build rusak.

Test HTTP menjalankan `next dev` sungguhan dengan `NEXT_DIST_DIR` sendiri (`.next-e2e`, `.next-qris`, `.next-idem`, `.next-f7`, …) supaya tidak merusak server dev yang mungkin sedang dipakai. **Dua proses `next dev` yang berbagi satu folder `.next` akan saling menghancurkan chunk-nya** dan menghasilkan 500 di semua route — lihat `docs/architecture.md` §18.1.

Setelah **menghapus** sebuah halaman, `npm run typecheck` bisa gagal dengan `Cannot find module '../../src/app/<nama>/page.js'`. Itu berkas tipe basi yang dibuat Next.js di folder `.next*`, bukan kesalahan kode. Hapus folder-folder itu lalu ulangi:

```bash
rm -rf .next .next-test .next-e2e .next-qris .next-reports .next-idem .next-f7 .next-build
```

## B4. Yang perlu diketahui sebelum mengubah uang

- Semua rupiah **integer**, tidak pernah float.
- Tidak ada `new Date()` di dalam modul logika — `now` selalu di-inject, supaya "server mati 3 hari" bisa diuji.
- Stok hanya boleh berubah lewat `applyStockMovement()`.
- Pelunasan pembayaran punya dua lapis gerbang, dan lapis kedua ada di DB (`updateMany where status='PENDING'` + `count === 1`).
- Endpoint uang menerima `idempotencyKey`; pengulangan mengembalikan transaksi yang sama, bukan membuat yang baru (§20).
- Kunci sekali-pakai dibuat dari `crypto.getRandomValues`, **bukan** `crypto.randomUUID` — yang terakhir tidak ada di HTTP tanpa TLS, jadi ia bekerja di localhost dan gagal di HP kasir (§20.4).

## B5. Backup, dari sisi kode

`VACUUM INTO`, bukan menyalin berkas: dengan WAL, `pos.db` mentah bisa tersalin dalam keadaan tidak konsisten.

Setiap backup diverifikasi dengan membuka berkasnya lewat `ATTACH DATABASE 'file:...?mode=ro'` lalu menjalankan `PRAGMA integrity_check` dan menghitung baris `transactions`. `mode=ro` bukan hiasan: tanpa itu SQLite berhak menulis ke berkas yang sedang diperiksa, dan alat pemeriksa berubah menjadi alat yang mengubah barang bukti.

Hanya backup yang lulus verifikasi yang disalin ke `BACKUP_MIRROR_DIR`. Hasilnya dicatat di audit log sebagai `BACKUP_RUN`, termasuk kalau gagal.

## B6. Export CSV

`GET /api/export/csv` menghasilkan satu ZIP berisi CSV per tabel. Penulis ZIP-nya ada di `src/lib/backup/zip.ts` — metode store, tanpa dependensi baru.

Kolom setiap tabel ditulis **eksplisit** di `src/lib/backup/export.ts`. Jadi kolom rahasia yang ditambahkan nanti tidak bisa ikut terbawa tanpa seseorang mengetiknya di sana lebih dulu. `users.pinHash` dan seluruh tabel `settings` (webhook, token) dikecualikan dengan sengaja.

Export bukan jalur pemulihan. Untuk memulihkan, yang dipakai adalah `.db` di `backups/` (A6).
