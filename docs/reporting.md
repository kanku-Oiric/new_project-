# Laporan — Definisi & Perhitungan

> Status: **Terpasang di Fase 6, bagian analisis AI menyusul di Fase 8.** Definisi di §1–§6 sudah berjalan sebagai kode; §7.3 mencatat apa yang belum dipakai. Pendamping `architecture.md` dan `database.md`.

Dokumen ini adalah **satu-satunya definisi** angka laporan. Kalau kode dan dokumen ini berbeda, salah satunya bug — dan yang diperbaiki harus disepakati, bukan diam-diam dibiarkan berbeda.

---

## 1. Definisi inti

```
Gross Sales   = Σ (unitPrice × qty)                    # sebelum diskon apa pun
Discounts     = Σ itemDiscount + Σ transactionDiscount
Net Sales     = Gross Sales − Discounts
COGS (HPP)    = Σ (unitCost × qty)                     # harga beli SNAPSHOT saat jual
Gross Profit  = Net Sales − COGS
```

**Aturan penamaan yang tidak bisa ditawar:** angka omzet tidak pernah dinamai "profit".
- `Gross Sales` dan `Net Sales` adalah **omzet/penjualan**.
- `Gross Profit` adalah **laba kotor**, dan hanya ada setelah HPP dikurangkan.
- Sistem ini **tidak** menghitung laba bersih (net profit), karena biaya di luar HPP dan pengeluaran kas harian tidak dicatat lengkap (pajak, penyusutan, gaji yang tidak lewat modul pengeluaran). Yang ada hanya `Gross Profit` dan `Total Pengeluaran` yang ditampilkan berdampingan, tanpa diselisihkan lalu disebut "laba bersih". Menyebutnya laba bersih akan menyesatkan pemilik dalam mengambil keputusan.

### 1.1 `unitCost` adalah snapshot, dan ini penting
`TransactionItem.unitCost` disalin dari `Product.hargaBeli` **pada saat penjualan**. Kalau harga beli naik besok, HPP transaksi kemarin **tidak** berubah.

Tanpa aturan ini, laporan bulan lalu akan berubah angkanya setiap kali pemilik memperbarui harga beli — dan laporan yang berubah sendiri tidak bisa dipercaya untuk keputusan apa pun.

---

## 2. Refund dan void

Dua hal berbeda, diperlakukan berbeda.

### 2.1 Void — dikecualikan sepenuhnya
Transaksi berstatus `VOIDED` **tidak masuk laporan sama sekali**. Tidak sebagai penjualan, tidak sebagai baris negatif.

Alasannya: void hanya boleh terjadi di hari yang sama saat shift masih terbuka (`architecture.md` §9.2). Secara ekonomi transaksi itu tidak pernah terjadi — kasir salah input lalu membatalkannya. Menampilkannya sebagai penjualan + pembatalan hanya menggelembungkan jumlah transaksi dan `Gross Sales` tanpa menambah informasi.

Jejaknya tetap ada: baris transaksi masih tersimpan dengan `voidedAt`/`voidedByUserId`/`voidReason`, `stock_movements` reason `SALE` dan `VOID` saling menghabiskan, dan `AuditLog` mencatatnya. Laporan punya baris terpisah **"Void hari ini: n transaksi"** sebagai indikator pengawasan — bukan bagian dari perhitungan penjualan.

### 2.2 Refund — dihitung pada tanggal refund
```
Refunds                    = Σ Refund.amount
Refunded COGS              = Σ Refund.cogsAmount
Net Sales after Refunds    = Net Sales − Refunds
Gross Profit after Refunds = Gross Profit − (Refunds − Refunded COGS)
```

**Refund diatribusikan ke tanggal refund terjadi, bukan tanggal penjualan asal.**

Ini pilihan sadar, dan alasannya: uang keluar dari laci pada hari refund. Kalau refund diatribusikan ke tanggal penjualan asal, laporan hari ini tidak akan cocok dengan uang fisik di laci hari ini, dan rekonsiliasi kas jadi mustahil. Konsekuensi yang harus diterima: laporan sebuah hari bisa berubah? **Tidak** — justru sebaliknya, laporan hari lampau **tidak pernah berubah** karena refund tidak pernah masuk ke belakang. Itu keuntungan utamanya.

Konsekuensi yang perlu dipahami pemilik: kalau barang dijual tanggal 10 dan di-refund tanggal 15, laporan tanggal 10 tetap menampilkan penjualan penuh dan laporan tanggal 15 menampilkan refund. Ini dicetak sebagai catatan kaki di laporan, supaya tidak dibaca sebagai kejanggalan.

Karena itu, laporan **selalu menampilkan dua pasang angka** dan diberi label jelas:
```
Penjualan Bersih            : Rp ...      (Net Sales)
Penjualan Bersih − Refund   : Rp ...      (Net Sales after Refunds)
Laba Kotor                  : Rp ...      (Gross Profit)
Laba Kotor − Refund         : Rp ...      (Gross Profit after Refunds)
```

---

## 3. Contoh perhitungan bernomor

Contoh ini adalah **test fixture**, bukan ilustrasi. Angka-angkanya dipakai langsung sebagai unit test.

### 3.1 Satu transaksi dengan diskon dua level

Keranjang:

| Item | `hargaJual` | `hargaBeli` | qty | `lineGross` | `itemDiscount` | `lineNet` |
|---|---|---|---|---|---|---|
| A | 15.000 | 11.000 | 2 | 30.000 | 0 | 30.000 |
| B | 7.000 | 5.000 | 3 | 21.000 | 1.000 | 20.000 |
| C | 3.500 | 2.500 | 1 | 3.500 | 0 | 3.500 |

```
grossSubtotal       = 30.000 + 21.000 + 3.500 = 54.500
itemDiscountTotal   = 1.000
Σ lineNet           = 53.500
transactionDiscount = 5.000   (dimasukkan kasir sebagai rupiah)
```

**Alokasi `transactionDiscount` dengan largest remainder**, bobot = `lineNet`:

| Item | Bobot | Nilai eksak | `floor` | Remainder |
|---|---|---|---|---|
| A | 30.000/53.500 | 2.803,738… | 2.803 | 0,738 ← terbesar |
| B | 20.000/53.500 | 1.869,158… | 1.869 | 0,158 |
| C | 3.500/53.500 | 327,102… | 327 | 0,102 |
| | | | **4.999** | |

Σ `floor` = 4.999, kurang 1 rupiah dari 5.000. Satu rupiah sisa diberikan ke remainder terbesar (A):

```
allocatedTxDiscount: A = 2.804, B = 1.869, C = 327   →  Σ = 5.000  ✓ persis
```

`lineFinal = lineNet − allocatedTxDiscount`:
```
A = 30.000 − 2.804 = 27.196
B = 20.000 − 1.869 = 18.131
C =  3.500 −   327 =  3.173
                      ───────
Σ lineFinal        = 48.500
netTotal = 54.500 − 1.000 − 5.000 = 48.500   ✓ cocok
```

HPP dan laba kotor:
```
cogsTotal    = (11.000×2) + (5.000×3) + (2.500×1) = 22.000 + 15.000 + 2.500 = 39.500
grossProfit  = 48.500 − 39.500 = 9.000
```

**Kenapa largest remainder, bukan `Math.round` per baris:** dengan `Math.round`, A→2.804, B→1.869, C→327 = 5.000 (kebetulan cocok di contoh ini), tapi untuk kombinasi lain hasilnya bisa 4.999 atau 5.001. Rupiah yang hilang atau tercipta dari udara akan membuat `netTotal` tidak sama dengan `Σ lineFinal`, dan invariant #4 di `database.md` gagal. Largest remainder membuat kecocokan itu **terjamin**, bukan kebetulan.

### 3.2 Refund sebagian — aturan teleskopik

Refund harus memenuhi satu syarat: **berapa pun urutan dan jumlah refund sebagiannya, kalau akhirnya seluruh qty di-refund, total refund == `lineFinal` persis.**

Rumusnya:
```
amount = floor(lineFinal × refundedQtyKumulatif / qty) − refundedAmountSebelumnya
```

Jadi bukan "hitung per refund lalu bulatkan", tapi "hitung total yang seharusnya sudah di-refund, lalu kurangi yang sudah dibayarkan". Pembulatan tidak pernah menumpuk.

Item B: `lineFinal = 18.131`, `qty = 3`. Refund satu per satu:

| Refund ke- | Kumulatif qty | `floor(18.131 × n/3)` | Sudah dibayar | **`amount`** |
|---|---|---|---|---|
| 1 | 1 | 6.043 | 0 | **6.043** |
| 2 | 2 | 12.087 | 6.043 | **6.044** |
| 3 | 3 | 18.131 | 12.087 | **6.044** |
| | | | Σ | **18.131** ✓ |

Dengan pembagian naif `round(18.131/3) = 6.044` tiga kali, totalnya 18.132 — **lebih 1 rupiah** dari yang pernah dibayar pelanggan. Toko kehilangan uang karena pembulatan, dan invariant #7 gagal.

HPP refund tidak punya masalah pembulatan karena perkalian integer:
```
cogsAmount = unitCost × refundQty = 5.000 × 1 = 5.000
```

Kalau item B di-refund 1 unit:
```
Refunds                    = 6.043
Refunded COGS              = 5.000
Net Sales after Refunds    = 48.500 − 6.043 = 42.457
COGS after Refunds         = 39.500 − 5.000 = 34.500
Gross Profit after Refunds = 42.457 − 34.500 = 7.957
  cek lewat rumus §2.2     = 9.000 − (6.043 − 5.000) = 7.957   ✓
```

### 3.3 Refund penuh
Refund seluruh item (A qty 2, B qty 3, C qty 1) dalam satu aksi:
```
A: floor(27.196 × 2/2) − 0 = 27.196
B: floor(18.131 × 3/3) − 0 = 18.131
C: floor( 3.173 × 1/1) − 0 =  3.173
                             ───────
                Σ          = 48.500  ==  netTotal  ✓ persis
```

---

## 4. Rekonsiliasi kas per shift

Satu shift per kasir, dengan kas awal dan laci/kantong masing-masing.

```
expectedCash = openingCash
             + cashSales      (Σ Payment.amount  WHERE method=CASH AND status=PAID
                                                 AND transaksi.status != 'VOIDED')
             − cashRefunds    (Σ Refund.amount   WHERE method=CASH AND shiftId = shift ini)
             − cashExpenses   (Σ Expense.amount  WHERE paidFrom='CASH_DRAWER'
                                                 AND deletedAt IS NULL)

difference   = countedCash − expectedCash
```

Tiga hal yang mudah salah di sini:

1. **Yang dijumlahkan `Payment.amount`, bukan `amountTendered`.** Kalau pelanggan menyerahkan Rp 100.000 untuk belanja Rp 48.500, yang masuk laci secara neto adalah Rp 48.500 — Rp 51.500 keluar lagi sebagai kembalian. Menjumlahkan `amountTendered` akan melipatgandakan angka kas.
2. **Hanya pengeluaran `paidFrom='CASH_DRAWER'`** yang mengurangi expected cash. Pengeluaran yang dibayar lewat transfer atau uang pribadi pemilik masuk laporan tapi **tidak** menyentuh laci.
3. **Refund dibebankan ke shift tempat refund terjadi**, bukan shift penjualan asal. Kalau tidak, uang keluar akan membebani laci yang sudah ditutup dan direkonsiliasi — yang bertentangan dengan aturan shift tertutup bersifat permanen.

`difference` boleh negatif (kurang uang) maupun positif (lebih uang). Keduanya disimpan apa adanya, tidak pernah dibulatkan ke nol dan tidak pernah "dikoreksi" otomatis. Selisih yang disembunyikan adalah selisih yang tidak akan pernah diperiksa.

### 4.1 Shift yang melewati tengah malam
Shift memakai `openedAt`/`closedAt` miliknya sendiri untuk rekonsiliasi kas, sementara laporan harian mengelompokkan per `businessDate` tiap transaksi. Konsekuensinya: **shift yang menyeberang tengah malam menyumbang ke dua laporan harian**, dan `cashSales` shift itu tidak akan sama dengan `cashSales` salah satu laporan harian.

Itu bukan bug, dan supaya tidak dibaca sebagai bug, laporan harian menampilkan ringkasan shift secara terpisah dengan label eksplisit:
```
Ringkasan Shift (berdasarkan waktu buka–tutup shift, bisa melewati tengah malam)
  Kasir Budi   06:00–14:10   Expected 1.240.000   Dihitung 1.235.000   Selisih −5.000
  Kasir Sari   14:10–22:05   Expected   980.000   Dihitung   980.000   Selisih       0
```

---

## 5. Isi laporan

### 5.1 Laporan harian
| Bagian | Isi |
|---|---|
| Penjualan | Gross Sales, Diskon (item + transaksi), Net Sales, Refunds, Net Sales after Refunds |
| Laba | COGS, Gross Profit, Gross Profit after Refunds |
| Aktivitas | Jumlah transaksi, rata-rata per transaksi, jumlah item terjual — **semuanya mengecualikan `VOIDED`** |
| Metode bayar | Tunai (jumlah + nominal), QRIS (jumlah + nominal) |
| Pengeluaran | Per kategori + total; dipisah `CASH_DRAWER` vs `OTHER` |
| Shift | Per kasir: jam, expected, dihitung, selisih |
| Produk terlaris | Top 10 per qty **dan** top 10 per laba kotor (dua daftar berbeda — barang paling ramai sering bukan barang paling menguntungkan) |
| Stok perlu diperiksa | Stok negatif dan stok ≤ `stokMinimum` |
| Pengawasan | Jumlah void, jumlah refund, total selisih kas |

**`jumlah transaksi` hanya menghitung transaksi berstatus `COMPLETED`.** Transaksi `VOIDED`, `CANCELLED`, dan `PENDING` semuanya dikecualikan:
- `VOIDED` — secara ekonomi tidak pernah terjadi (§2.1).
- `CANCELLED` — termasuk transaksi QRIS terlantar yang dibatalkan otomatis saat tutup shift; tidak pernah dibayar dan tidak pernah menyentuh stok.
- `PENDING` — belum selesai.

Ini berlaku konsisten untuk ketiga angka di baris Aktivitas. Kalau `VOIDED` ikut terhitung, `jumlah transaksi` menggelembung sementara `Net Sales` tidak, sehingga `rata-rata per transaksi` turun tanpa sebab nyata — angka yang bergerak karena kesalahan input kasir, bukan karena perilaku pelanggan.

`Rata-rata per transaksi` = `Net Sales / jumlah transaksi`. Kalau jumlah transaksi 0 → tampilkan `—`, **bukan** `0` dan bukan `NaN`. Pembagian dengan nol diuji secara eksplisit.

### 5.2 Mingguan & bulanan
Metrik yang sama, ditambah:
- Perbandingan terhadap periode sebelumnya (nominal dan persentase). Kalau periode sebelumnya bernilai 0, persentase ditampilkan `—`, bukan `∞` atau `100%`.
- Tren per hari (mingguan) / per minggu (bulanan).
- Bagian analisis AI **kalau** `AI_ENABLED=true` dan panggilan berhasil serta lolos validasi Zod. Kalau tidak, bagian ini **tidak muncul** — tidak ada placeholder dan tidak ada pesan error di laporan yang dikirim ke pemilik.

Dari mana teks analisis itu datang (lihat `architecture.md` §12):

| Jalur | Apakah memanggil API |
|---|---|
| Membuka `/laporan` | **Tidak.** Hanya membaca `ai_insights`. Membuka halaman lima kali tidak menghabiskan kuota |
| Menekan "Minta analisis" | Ya, kalau belum ada hasil tersimpan dan kuota hari ini belum terpakai |
| Pengiriman laporan otomatis | Ya, sekali, dengan aturan yang sama. Kalau gagal, laporannya **tetap terkirim** tanpa bagian itu |
| Pengiriman ULANG periode yang sama | **Tidak.** Hasil tersimpan sudah menempel saat pesan disusun |

Kegagalan analisis tidak pernah menandai pengiriman gagal. Kodenya memang berada di luar blok yang menentukan status pengiriman — kegagalan di bagian pinggir tidak boleh menjatuhkan bagian yang penting.

---

## 6. `periodKey`

Identitas periode yang dipakai `report_deliveries` untuk idempotensi.

| Kind | Format | Contoh | Definisi |
|---|---|---|---|
| `DAILY` | `YYYY-MM-DD` | `2026-09-18` | Satu `businessDate` WIB |
| `WEEKLY` | `YYYY-Www` | `2026-W38` | ISO-8601: Senin–Minggu, **ISO week-year** |
| `MONTHLY` | `YYYY-MM` | `2026-09` | Bulan kalender WIB |

### 6.1 Jebakan ISO week-year
**ISO week-year tidak selalu sama dengan tahun kalender.** ISO week 1 adalah minggu yang memuat Kamis pertama Januari.

Contoh nyata yang harus lolos test:
- **2026-01-01 jatuh hari Kamis** → minggu itu adalah `2026-W01`, yang **dimulai Senin 29 Desember 2025**.
- Artinya transaksi tanggal **2025-12-29** punya `periodKey` mingguan **`2026-W01`**, bukan `2025-W53`.

Memakai `getFullYear()` untuk menyusun kunci mingguan akan menghasilkan `2025-W01` di sini — kunci yang salah, yang membuat catch-up mengirim laporan ganda atau melewatkan satu minggu. Karena itu `isoWeekKey(date, tz)` menghitung ISO week-year secara terpisah dari tahun kalender, dan diuji tepat pada batas tahun.

Verifikasi contoh utama: 2026-W38 dimulai Senin 14 September 2026; **2026-09-18 adalah hari Jumat di minggu ke-38**.

### 6.2 Kapan sebuah periode dianggap "selesai"
Catch-up **hanya** mengirim periode yang sudah berakhir:
- `DAILY` selesai setelah `businessDate` berganti di WIB (jadi hari ini tidak pernah dikirim otomatis).
- `WEEKLY` selesai setelah Minggu berakhir.
- `MONTHLY` selesai setelah hari terakhir bulan itu berakhir.

### 6.3 `trigger` — memisahkan pengiriman otomatis dari manual

Tombol **"Kirim laporan sekarang"** boleh mengirim periode yang belum selesai (misalnya laporan hari ini pada jam 15:00). Tapi pengiriman manual **tidak boleh** menandai periode itu sudah terkirim, karena kalau begitu laporan penuh hari itu tidak akan pernah terkirim malam nanti.

Karena itu `report_deliveries` punya kolom **`trigger`**:

| `trigger` | Dibuat oleh | Boleh berulang? | Diperhitungkan catch-up? |
|---|---|---|---|
| `AUTO` | Catch-up saat startup & cron | ❌ Tidak — satu per `(kind, periodKey, channel)` | ✅ Ya |
| `MANUAL` | Tombol "Kirim laporan sekarang" & retry manual | ✅ Ya, sebanyak yang diminta | ❌ Tidak |

Catch-up mencari periode terakhir yang berhasil dengan filter eksplisit:
```sql
WHERE kind = ? AND channel = ? AND trigger = 'AUTO' AND status = 'SENT'
ORDER BY periodKey DESC LIMIT 1
```

**Penegakan uniknya tidak bisa memakai `@@unique([kind, periodKey, channel, trigger])`.** Constraint itu memang memisahkan AUTO dari MANUAL, tapi juga akan **menolak pengiriman manual kedua untuk periode yang sama** — padahal menekan "Kirim laporan sekarang" dua kali (karena pesan pertama terlewat, atau pemilik ingin mengirim ulang) adalah hal yang wajar dan harus berhasil, bukan melempar error constraint.

Solusinya kolom nullable **`dedupeKey String? @unique`**, pola yang sama dengan `openKey` pada shift (`database.md` §1.4):

```
trigger = AUTO    →  dedupeKey = "DAILY|2026-09-17|DISCORD"
trigger = MANUAL  →  dedupeKey = null
```

SQLite mengizinkan banyak NULL pada kolom unique, jadi:
- Pengiriman `AUTO` yang sama **ditolak database** — inilah penjaga anti-kirim-ganda saat catch-up, tetap ditegakkan di level DB, bukan hanya di kode.
- Pengiriman `MANUAL` boleh berapa kali pun tanpa bertabrakan.

Kolom `trigger` tetap ada sebagai data eksplisit untuk filter catch-up, tampilan dashboard, dan audit — `dedupeKey` hanya alat penegakan constraint, bukan penggantinya.

---

## 7. Perhitungan ulang & catch-up

### 7.1 Semua angka bisa dihitung ulang
**Tidak ada satu pun angka laporan yang disimpan di database.** Layer DB hanya mengambil baris mentah untuk rentang `businessDate`; seluruh matematika dilakukan fungsi murni `aggregateSales(rows, opts)` yang tidak menyentuh DB.

Konsekuensi yang disengaja dan berharga: laporan tanggal berapa pun bisa dihitung ulang kapan pun, termasuk **setelah bug perhitungan diperbaiki**, tanpa migrasi data. Kalau angka agregat disimpan, memperbaiki bug berarti data lama tetap salah selamanya.

### 7.2 Catch-up "server mati 3 hari"
Laptop toko dimatikan tiap malam, jadi cron **pasti** melewatkan laporan. Catch-up saat startup adalah mekanisme utama; cron hanya optimisasi yang memanggil fungsi yang sama.

```
missingPeriods(kind, lastSentKey, now, cap) → periodKey[]
```
Fungsi murni, `now` di-inject, cap default 60 periode.

Skenario test wajib:

| Langkah | Harapan |
|---|---|
| Seed transaksi untuk 2026-09-15, 16, 17. Delivery DAILY terakhir `SENT` = `2026-09-14`. `now` = 2026-09-18 08:00 WIB | |
| Jalankan `catchUpReports(now)` | Tepat **3** laporan terkirim, urut `09-15` → `09-16` → `09-17`. `09-18` **tidak** dikirim (hari ini belum selesai) |
| Jalankan `catchUpReports(now)` lagi | **0** pengiriman — unique `(kind, periodKey, channel)` menolak klaim ulang |
| Provider dibuat gagal total, lalu jalankan | 3 baris `FAILED` dengan `lastError`, aplikasi **tidak crash**, transaksi tetap bisa jalan |
| `lastSentKey` = 6 bulan lalu | Maksimum `cap` periode terkirim, tidak 180 pesan |
| `lastSentKey` = null (instalasi baru) | Mulai dari `businessDate` transaksi paling awal, atau setting `installDate` |
| Kirim manual `2026-09-18` jam 15:00, lalu jalankan catch-up malam itu | Baris `MANUAL` tercatat; `09-18` **tetap** dikirim sebagai `AUTO` setelah hari berakhir |
| Tekan "Kirim laporan sekarang" dua kali untuk periode yang sama | Dua baris `MANUAL` berhasil, **tanpa error constraint** (§6.3) |

Urutan pengiriman dari paling lama ke paling baru, satu per satu, dengan jeda antar-kirim untuk menghormati rate limit.

Seluruh skenario di tabel itu ada sebagai test di `tests/catchup.test.ts`, dijalankan dengan jam palsu dan provider palsu — tidak ada satu pun request keluar saat test berjalan.

### 7.3 Aturan waktu kirim, dan setting yang BELUM dipakai

Aturan yang berlaku sekarang, satu kalimat: **periode yang sudah selesai dikirim segera setelah aplikasi menyadarinya** — entah saat server menyala (catch-up) atau saat scheduler berdetak.

Konsekuensinya jujur disebutkan: kalau laptop menyala melewati tengah malam, laporan kemarin terkirim beberapa menit setelah pukul 00:00 WIB. Kalau laptop mati, laporan itu terkirim saat server dinyalakan besok pagi.

Karena itu **`reportDailyTime`, `reportWeeklyDay`, dan `reportMonthlyDay` belum dipakai kode mana pun.** Ketiganya ada di tabel settings sejak Fase 1, dan sengaja dibiarkan tidak aktif alih-alih dipasang setengah jalan.

Alasannya: menjadikannya jam kirim akan bertabrakan dengan §6.2. "Kirim laporan harian pukul 21:00" berarti mengirim hari yang belum berakhir — angkanya belum final dan toko mungkin masih buka. Sedangkan menjadikannya gerbang untuk hari kemarin akan melahirkan dua perilaku berbeda pada satu sistem: catch-up saat startup mengirim pukul 08:00 pagi, sementara scheduler menunggu sampai 21:00. Dua jalur dengan aturan berbeda persis yang dihindari §10.3 `architecture.md`.

Pilihan yang tersisa kalau pemilik memang menginginkan jam tetap: gerbang itu harus berlaku untuk **kedua** jalur, termasuk catch-up saat startup — yang berarti laporan kemarin sengaja ditahan sampai malam ini. Itu keputusan pemilik toko, bukan keputusan yang pantas diambil diam-diam oleh kode. Sampai diputuskan, ketiga setting itu tidak muncul di UI mana pun, supaya tidak ada tombol yang tampak berpengaruh padahal tidak.

Yang dipakai scheduler hanyalah jeda pemeriksaan: berdetak tiap menit, tetapi catch-up hanya benar-benar dijalankan kalau hari usaha berganti atau sudah lewat sepuluh menit sejak pemeriksaan terakhir (`shouldRunCatchUp`). Database yang sama sedang dipakai kasir; enam query tiap menit hanya untuk mendapati tidak ada yang perlu dikirim adalah gangguan tanpa manfaat.

---

## 8. Ketentuan numerik

| Hal | Aturan |
|---|---|
| Satuan | Integer rupiah penuh di seluruh pipeline |
| Pembulatan diskon persen | `Math.round` (half-up untuk nilai non-negatif), dilakukan **sekali** saat input |
| Alokasi diskon transaksi | Largest remainder, Σ alokasi == diskon **persis** |
| Alokasi refund | Teleskopik (§3.2), Σ refund penuh == `lineFinal` **persis** |
| HPP | `unitCost × qty` — perkalian integer, tanpa pembulatan |
| Agregasi | JS `number` (aman sampai 2^53); **tidak pernah** disimpan sebagai kolom `Int` |
| Pembagian (rata-rata, persentase) | Hanya di layer tampilan. Pembagi 0 → `—`, bukan `0`/`NaN`/`∞` |
| Persentase | Dihitung dari integer, ditampilkan 1 desimal. Tidak pernah dipakai untuk menghitung ulang nominal |
