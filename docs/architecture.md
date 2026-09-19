# Arsitektur — Sistem Kasir Toko

> Status: **Draft untuk review.** Belum ada kode aplikasi. Dokumen ini + `database.md` + `reporting.md` + `qris.md` adalah deliverable Fase 0.

---

## 1. Konteks pemakaian

Ini yang menentukan seluruh keputusan teknis di bawah. Kalau konteks ini berubah, dokumen ini harus ditinjau ulang.

| Fakta | Konsekuensi |
|---|---|
| Satu toko, bukan multi-cabang | Tidak ada konsep `store_id`, tidak ada tenancy |
| Beberapa kasir bekerja bersamaan di device berbeda | Concurrency DB adalah risiko utama (§6) |
| Semua device di satu WiFi LAN toko | Server di-bind ke `0.0.0.0`, diakses via IP LAN |
| Satu laptop toko menjadi server | Laptop dimatikan tiap malam → catch-up saat startup (§10) |
| Internet hanya untuk kirim laporan | Kasir wajib tetap bisa bertransaksi penuh tanpa internet |

### 1.1 Yang **tidak** kita bangun, dan alasannya

Semua device menulis ke **satu** database di LAN. Karena itu:

- ❌ **Tidak ada offline sync engine** — tidak ada dua salinan data yang perlu disatukan.
- ❌ **Tidak ada outbox queue untuk transaksi** — client tidak pernah menjadi sumber kebenaran.
- ❌ **Tidak ada conflict resolution / CRDT / vector clock** — tidak ada konflik yang bisa terjadi.
- ❌ **Tidak ada replikasi database.**
- ❌ **Tidak ada service worker caching agresif** — lihat §13.

**Server adalah satu-satunya sumber kebenaran.** Kalau LAN mati, kasir memang berhenti — itu keputusan sadar, bukan kelalaian. Membangun offline engine untuk kasus ini adalah salah, bukan cuma berlebihan: ia menciptakan dua sumber kebenaran yang tidak dibutuhkan, lalu membawa seluruh kelas bug yang menyertainya.

Yang justru wajib benar dan mendapat porsi terbesar di dokumen ini: **atomicity checkout**, **concurrency SQLite**, **business day WIB**, **catch-up laporan**, dan **backup**.

---

## 2. Stack

| Bagian | Pilihan | Alasan |
|---|---|---|
| App | Next.js 15 App Router + TypeScript | Satu proses untuk UI + API, tanpa deployment terpisah |
| TS config | `strict: true`, `noUncheckedIndexedAccess: true` | Larangan `any` sembarangan ditegakkan compiler |
| DB | SQLite via Prisma, file `data/pos.db` | Satu file, nol administrasi, cocok untuk satu laptop toko |
| CSS | Tailwind CSS v4 | Tanpa component library berat |
| Validasi | Zod | Semua input client divalidasi, skema jadi sumber tipe |
| Test | Vitest | Cepat, unit test modul murni tanpa DB |
| Hash PIN | `bcryptjs` | Pure JS — tidak ada native build yang gagal di Windows |
| Docker | ❌ tidak dipakai | `npm install && npm run dev` harus cukup |

`DATABASE_URL="file:../data/pos.db?connection_limit=1"` — relatif terhadap folder `prisma/`, sehingga file DB berada di `<root>/data/pos.db`. `connection_limit=1` wajib, alasannya di §6.3.

Script:
```json
"dev":       "next dev -H 0.0.0.0 -p 3000",
"build":     "next build",
"start":     "next start -H 0.0.0.0 -p 3000",
"typecheck": "tsc --noEmit",
"lint":      "next lint",
"test":      "vitest run",
"db:migrate":"prisma migrate dev",
"db:seed":   "prisma db seed"
```

Bind `0.0.0.0` wajib — tanpa itu device lain di LAN tidak bisa mengakses. Untuk pemakaian toko sehari-hari gunakan `build` + `start`, bukan `dev` (dev mode jauh lebih lambat dan tidak pantas dipakai saat toko ramai).

---

## 3. Struktur folder

```
kasir-toko/
├─ data/                    pos.db, pos.db-wal, pos.db-shm, uploads/, logs/   (gitignored)
├─ backups/                 pos-YYYYMMDD-HHmmss.db  (30 terbaru)              (gitignored)
├─ docs/                    architecture.md  database.md  reporting.md  qris.md
├─ prisma/                  schema.prisma  migrations/  seed.ts
└─ src/
   ├─ instrumentation.ts  ← hook startup (backup + PRAGMA + catch-up).
   │                         WAJIB di src/, bukan root: project ini memakai
   │                         folder src/, dan Next.js hanya mencarinya di sana.
   ├─ app/
   │  ├─ (auth)/login/
   │  ├─ kasir/  shift/  pengeluaran/  transaksi/  produk/
   │  ├─ laporan/  dashboard/  pengaturan/  audit/  struk/[id]/
   │  └─ api/...             (daftar lengkap di §14)
   ├─ components/            kasir/  shift/  produk/  laporan/  ui/
   └─ lib/
      ├─ money/     formatRupiah, parseRupiah, roundRupiah
      ├─ cart/      hitung baris, diskon item, alokasi diskon transaksi, total
      ├─ payment/   kembalian, tombol cepat, canTransition()
      ├─ shift/     expectedCash, difference
      ├─ refund/    refundableQty, alokasi nominal refund
      ├─ report/    aggregateSales, buildReportMessage
      ├─ schedule/  missingPeriods, isDue
      ├─ time/      businessDate WIB, ISO week key, rentang UTC
      ├─ receipt/   buildReceipt (murni) + renderer HTML   ← batas modul cetak
      ├─ notify/    Discord / Telegram / WhatsApp-stub + queue + backoff
      ├─ ai/        buildAiPayload, skema Zod, client Gemini
      ├─ db/        prisma singleton, pragma, applyStockMovement, nextNumber
      ├─ auth/      session, PIN, rate limit, withAuth, requireOwnerPin
      └─ backup/    vacuumInto, prune, exportCsv
```

### 3.1 Aturan kerja yang ditegakkan

1. **Semua perhitungan ada di `src/lib/*` sebagai fungsi murni** — tanpa akses DB, tanpa `fetch`, tanpa `new Date()` internal. Yang termasuk: total keranjang, diskon, alokasi diskon transaksi, kembalian, expected cash, alokasi refund, agregasi laporan, penentuan periode terlewat.
2. **`now: Date` selalu di-inject sebagai parameter.** Tanpa ini, test "server mati 3 hari" tidak mungkin ditulis.
3. **Tidak ada data hardcoded sebagai pengganti query DB.**
4. **Tidak ada exception yang ditelan diam-diam.** Setiap `catch` harus me-log dan/atau melempar ulang error bertipe.
5. **Tidak ada `any` sembarangan.** Kalau tipe tidak diketahui → `unknown` + Zod parse.
6. **Komponen React dipecah kecil**, satu tanggung jawab per komponen.
7. **`product.stok` hanya boleh berubah lewat `applyStockMovement()`** di dalam DB transaction. Tidak ada UPDATE stok langsung di tempat lain, sehingga setiap perubahan pasti meninggalkan jejak.

---

## 4. Aturan uang

**Semua nominal rupiah adalah integer rupiah penuh.** Kolom `Int`. Tidak ada `Float`, `Double`, `Decimal`, atau string angka. Rupiah tidak punya sen — tidak ada alasan memakai pecahan.

Format **hanya** di layer tampilan, lewat satu helper terpusat:
```ts
formatRupiah(15000)            // "Rp 15.000"
formatRupiah(15000, {bare:true}) // "15.000"
parseRupiah("Rp 15.000")       // 15000
```

Batas yang harus diketahui:

- **Prisma `Int` = 32-bit signed → ceiling Rp 2.147.483.647 per kolom.** Aman untuk nominal per-baris, per-transaksi, per-shift.
- **Agregasi laporan TIDAK PERNAH disimpan sebagai kolom `Int`.** Omzet setahun toko yang menjual Rp 10 juta/hari = Rp 3,65 miliar — itu **melewati** ceiling `Int`. Karena itu semua agregat dihitung on-the-fly sebagai JS `number` (safe integer 2^53 ≈ 9 kuadriliun rupiah, lebih dari cukup). Ini sekaligus menghindari seluruh rasa sakit serialisasi `BigInt` di JSON.
- **Diskon persen adalah kemudahan UI, bukan sumber kebenaran.** Saat kasir memasukkan "10%", nilai itu langsung dikonversi ke rupiah integer (`Math.round`, half-up untuk nilai non-negatif) dan **integer itulah** yang disimpan. Persen tidak pernah disimpan dan tidak pernah dihitung ulang, sehingga total tidak bisa bergeser.

### 4.1 Model diskon

Dua level diskon, dan keduanya harus eksplisit karena ini titik yang paling sering salah:

```
Per item:
  lineGross = unitPrice × qty
  lineNet   = lineGross − itemDiscount

Per transaksi:
  transactionDiscount dialokasikan proporsional ke setiap baris
  dengan bobot lineNet, memakai LARGEST REMAINDER METHOD

  lineFinal = lineNet − allocatedTxDiscount
  netTotal  = Σ lineFinal
```

**Kenapa largest remainder:** pembagian proporsional biasa dengan `Math.round` per baris bisa membuat Σ alokasi ≠ `transactionDiscount` — rupiah hilang atau tercipta dari udara. Largest remainder membagikan sisa pembulatan ke baris dengan remainder terbesar, sehingga **Σ alokasi == transactionDiscount persis**, selalu. Ini diuji dengan ratusan kombinasi qty/harga/diskon.

Hasil alokasi **disimpan** di `transaction_items.allocatedTxDiscount`. Bukan dihitung ulang saat laporan atau refund — kalau dihitung ulang, hasilnya bisa menyimpang dari yang tercetak di struk pelanggan.

---

## 5. Waktu & business day

Sumber bug klasik, jadi ditetapkan sekali di sini.

- **Semua timestamp disimpan UTC** (`DateTime` Prisma).
- **Semua pengelompokan laporan memakai kolom `businessDate`**: `String` format `"YYYY-MM-DD"` dalam zona **Asia/Jakarta (WIB, UTC+7)**, didenormalisasi ke `Transaction`, `Refund`, `Expense`, `Shift`, `StockMovement`.

Kenapa denormalisasi `businessDate` alih-alih menghitung rentang UTC tiap query:
1. Grouping laporan jadi deterministik dan bisa di-index.
2. Pertanyaan "tanggal mana yang laporannya belum terkirim" menjadi trivial — krusial untuk catch-up (§10).
3. Kalau setting timezone berubah suatu hari, data historis tidak berubah artinya secara diam-diam.

Implementasi: `Intl.DateTimeFormat(...).formatToParts()` dengan `timeZone` dari setting, lalu assemble `YYYY-MM-DD` manual (locale-independent). Tanpa dependency date library. Diuji di sekitar tengah malam WIB (23:59 dan 00:01) dan di sekitar batas bulan/tahun.

**Hari usaha = hari kalender WIB.** Shift yang melewati tengah malam tetap memakai `openedAt`/`closedAt` miliknya sendiri untuk rekonsiliasi kas, sedangkan laporan harian memakai `businessDate` tiap transaksi. Artinya: shift yang menyeberang tengah malam akan menyumbang ke dua laporan harian yang berbeda, dan itu benar. Konsekuensi rekonsiliasinya dijelaskan di `reporting.md`.

WIB tidak punya DST dan tidak pernah punya, jadi tidak ada kasus jam ganda/hilang.

---

## 6. Concurrency SQLite — inti kebenaran multi-kasir

Beberapa kasir menulis ke satu DB bersamaan. Ini bagian yang paling mudah salah dan paling mahal akibatnya.

### 6.1 PRAGMA wajib (dijalankan saat startup, sebelum query apa pun)
```sql
PRAGMA journal_mode = WAL;     -- banyak reader + satu writer, tanpa saling blokir total
PRAGMA busy_timeout = 5000;    -- tunggu 5s alih-alih langsung SQLITE_BUSY
PRAGMA foreign_keys = ON;      -- SQLite defaultnya OFF (!)
PRAGMA synchronous = NORMAL;   -- aman dengan WAL, jauh lebih cepat dari FULL
```
`foreign_keys = ON` penting: SQLite mematikan foreign key **secara default**, jadi tanpa baris ini semua relasi kita hanya dekorasi.

### 6.2 Prisma client singleton
Pola `globalThis` supaya HMR di dev tidak membuat puluhan koneksi:
```ts
const g = globalThis as { prisma?: PrismaClient }
export const prisma = g.prisma ?? new PrismaClient()
if (process.env.NODE_ENV !== 'production') g.prisma = prisma
```

### 6.3 `connection_limit=1` — wajib, bukan penyetelan performa

```
DATABASE_URL="file:../data/pos.db?connection_limit=1"
```

SQLite hanya mengizinkan **satu penulis pada satu waktu**. Pool koneksi default
Prisma membuka beberapa koneksi, sehingga beberapa checkout bersamaan menjadi
beberapa transaction yang saling berebut write lock. Yang terjadi bukan sekadar
lambat — mereka saling memblokir sampai socket timeout, lalu **semuanya
di-rollback**.

Diukur pada DB kosong, 8 checkout bersamaan:

| Konfigurasi | Waktu | Hasil |
|---|---|---|
| Pool default Prisma | 5.463 ms | **socket timeout, 8 transaksi GAGAL**, stok tidak berubah sama sekali |
| `connection_limit=1` | **26 ms** | 8 transaksi sukses, stok berkurang tepat 8 |

Dengan satu koneksi, checkout **mengantre** alih-alih berebut. Antrean itu murah:
satu checkout selesai dalam hitungan milidetik, jadi tiga kasir yang menekan
tombol bersamaan tidak akan pernah merasakannya.

Ada konsekuensi kedua yang sama pentingnya: **PRAGMA berlaku per-koneksi.**
Dengan pool lebih dari satu, `PRAGMA busy_timeout` yang dijalankan saat startup
hanya mengenai satu koneksi dan tidak berlaku untuk sisanya. Satu koneksi
membuat penerapan PRAGMA menjadi pasti, bukan kebetulan.

Batasnya harus jujur disebut: satu koneksi berarti pembacaan juga ikut
mengantre di belakang penulisan. Untuk satu toko dengan beberapa kasir dan
ratusan transaksi per hari, ini tidak terasa. Kalau suatu saat beban naik jauh,
jawabannya bukan menaikkan `connection_limit` — melainkan pindah ke database
yang memang mendukung banyak penulis.

### 6.4 Pengurangan stok WAJIB atomic di SQL

```sql
UPDATE products SET stok = stok - ?, updatedAt = ? WHERE id = ? RETURNING stok;
```

**Ini bukan preferensi gaya, ini koreksi bug.** Pola baca-lalu-tulis:
```
Kasir A: baca stok=10 → hitung 10-1=9 → tulis 9
Kasir B: baca stok=10 → hitung 10-1=9 → tulis 9     ← update kasir A HILANG
Hasil: 2 barang terjual, stok cuma turun 1
```
Alasan ini **tetap berlaku walaupun stok minus diizinkan** — masalahnya bukan pengecekan batas, tapi *lost update*.

`RETURNING` butuh SQLite ≥ 3.35 dan diakses lewat `$queryRaw` (bukan `$executeRaw`, yang hanya mengembalikan jumlah baris). Fallback kalau `RETURNING` tidak tersedia: `UPDATE` lalu `SELECT stok` **di dalam transaction yang sama** — tetap benar karena write SQLite terserialisasi.

`stockBefore` diturunkan dari `stockAfter + (-qtyChange)`, sehingga konsisten dengan nilai yang benar-benar ditulis, bukan dengan nilai yang dibaca sebelum update.

### 6.5 Aturan transaction
- Write transaction **sependek mungkin**.
- **Tidak ada panggilan jaringan di dalam DB transaction**, pernah. Kirim Discord/Telegram/Gemini selalu setelah commit.
- Tidak ada `await` ke hal lain selain query DB di dalam `$transaction`.

### 6.6 Nomor transaksi
`TRX-20260918-000123` untuk manusia, UUID sebagai primary key.

Sequence diambil dari tabel `daily_counters` yang di-increment **di dalam DB transaction yang sama** dengan pembuatan transaksi, ditambah `@unique` pada `trxNumber` sebagai jaring pengaman. Pola yang sama untuk refund: `RFN-20260918-000045`.

---

## 7. Auth & otorisasi

### 7.1 Login
PIN itu entropi rendah (4–6 digit), jadi alurnya: **pilih user dari daftar → masukkan PIN**.

Kenapa bukan "PIN saja tanpa pilih user": itu memaksa PIN unik antar seluruh karyawan, membuat tebakan satu PIN membuka akun siapa pun, dan memaksa server mem-bcrypt terhadap setiap user pada tiap percobaan. Memilih user dulu tetap cepat untuk kasir (satu tap + 4 digit) dan jauh lebih jelas.

- bcrypt cost 10.
- **5 kali gagal → lock 5 menit, berjenjang.** Setiap kegagalan tercatat sebagai `LOGIN_FAILED` di audit log.
- Session: token random opaque di cookie `httpOnly` + `sameSite=lax`. Yang disimpan di DB adalah **sha256 dari token**, sehingga isi tabel session tidak bisa dipakai untuk menyamar. Sliding expiry 12 jam.
- Seed memberi PIN default dan menandai `mustChangePin=true`; aplikasi menampilkan banner sampai PIN diganti.

**Catatan jujur:** LAN toko berjalan HTTP tanpa TLS, jadi cookie **tidak** bisa memakai flag `secure`. Ini dapat diterima untuk jaringan tertutup di dalam satu toko, dan ditulis apa adanya di README — bukan disembunyikan.

### 7.2 Role
| Role | Akses |
|---|---|
| `OWNER` | Semua |
| `CASHIER` | Kasir, shift, cetak struk, pengeluaran, lihat transaksinya |

**Otorisasi dicek di server.** Menyembunyikan tombol di frontend bukan otorisasi — setiap route handler dibungkus `withAuth(role)` yang membaca session dari DB dan menolak sebelum logika apa pun berjalan.

### 7.3 PIN owner untuk aksi sensitif
Void, refund, hapus pengeluaran, dan ubah pengaturan **selalu** meminta PIN owner dikirim ulang di body request, diverifikasi server-side terhadap user ber-role `OWNER`. Tidak mengandalkan session — supaya kasir yang meninggalkan device tidak otomatis memberi akses owner. Kena rate limit yang sama seperti login, dan `authorizedByUserId` dicatat.

### 7.4 Pola handler
```
withAuth(role) → parseBody(zodSchema, req) → service → handleApiError
```
Error envelope seragam: `{ error: { code, message, details? } }`. Hirarki `AppError` dengan `httpStatus`. `handleApiError` me-log error lengkap di server dan mengembalikan pesan aman ke client — **tidak ada exception yang hilang**.

---

## 8. Alur checkout — satu DB transaction, atomic

Satu fungsi internal dipakai **baik oleh tunai maupun QRIS**, sehingga state machine pembayaran identik apa pun providernya dan provider asli nanti tidak perlu menyentuh kode transaksi:

```ts
settleTransaction(tx, transactionId, actor)
```

### Fase 1 — `POST /api/transactions` (satu `prisma.$transaction`)
1. Validasi body dengan Zod.
2. **Ambil `hargaJual` dan `hargaBeli` dari DB**, bukan dari client. Client hanya mengirim `productId` + `qty` + diskon.
3. Hitung seluruh total lewat modul murni `lib/cart`.
4. Ambil nomor dari `daily_counters`.
5. Insert `Transaction` (status `PENDING`) + `TransactionItem[]` (dengan snapshot nama/sku/harga/HPP) + `Payment` (status `PENDING`).
6. Kalau `method = CASH` → lanjut `settleTransaction` **di dalam transaction yang sama**.
   Kalau `method = QRIS_STATIC` → berhenti di `PENDING`, tampilkan QR statis.

### Fase 2 — `settleTransaction`
1. Transisi pembayaran `PENDING → PAID` **bergerbang**:
   `updateMany({ where: { id, status: 'PENDING' }, data: {...} })` → periksa `count === 1`.
   Kalau `0`, berarti device lain sudah memproses → tolak dengan error jelas. **Tidak ada double-apply.**
2. Untuk setiap item: `UPDATE ... RETURNING` stok (§6.4) → insert `StockMovement` reason `SALE`.
3. `Transaction.status = COMPLETED`, `completedAt` diisi.
4. Insert `AuditLog`.

**Satu langkah gagal → rollback semuanya.** Mustahil ada pembayaran tercatat tapi stok tidak berkurang. Itulah alasan seluruh urutan ini berada dalam satu transaction.

### Stok minus
Sesuai keputusan pemilik: **checkout tidak pernah diblokir karena stok kurang.** Penjualan nyata lebih penting daripada angka stok yang memang sering tidak akurat.

Yang dilakukan sebagai gantinya:
- Response mengembalikan daftar item yang stoknya menjadi negatif.
- UI kasir menampilkan peringatan jelas setelah transaksi sukses (tidak menghalangi, tidak modal yang harus ditutup).
- `stockAfter` negatif tetap tercatat di `stock_movements`.
- Laporan harian punya bagian **"stok perlu diperiksa"** yang memuat semua produk dengan stok negatif atau di bawah `stokMinimum`, sehingga masalah ini muncul ke permukaan dan tidak menumpuk diam-diam.

---

## 9. Shift, void, refund

### 9.1 Shift — satu shift per kasir
Setiap kasir membuka shift sendiri dengan kas awalnya sendiri (laci atau kantong uang masing-masing), dan selisih kas dihitung per kasir.

```
expectedCash = openingCash
             + penjualan tunai   (Σ Payment.amount, method=CASH, status=PAID, transaksi bukan VOIDED)
             − refund tunai      (Σ Refund.amount, method=CASH, shift ini)
             − pengeluaran kas   (Σ Expense.amount, paidFrom=CASH_DRAWER, belum dihapus)

difference   = countedCash − expectedCash
```

Yang dijumlahkan adalah **`Payment.amount`** (nominal transaksi), **bukan `amountTendered`** — uang kembalian sudah otomatis ter-net, dan menjumlahkan uang yang diserahkan pelanggan akan salah.

- Kasir **tidak bisa** checkout tanpa shift `OPEN`. Setiap transaksi wajib punya `shiftId`.
- Satu shift `OPEN` per kasir, ditegakkan di level DB (lihat `database.md`, trik kolom `openKey`).
- Tutup shift → tulis `expectedCash`/`countedCash`/`difference` → **backup otomatis**.
- **Shift tertutup bersifat permanen.** Tidak ada endpoint update atau delete untuk shift berstatus `CLOSED`, sama sekali, untuk siapa pun.

#### Transaksi `PENDING` saat tutup shift

Transaksi QRIS yang ditinggalkan (pelanggan berubah pikiran, kasir lupa menekan Batalkan) akan menggantung berstatus `PENDING`. Aturannya:

**Saat shift ditutup, semua transaksi `PENDING` milik shift itu otomatis menjadi `CANCELLED`** — pembayarannya `PENDING → CANCELLED` — di dalam DB transaction yang sama dengan penutupan shift, dan setiap pembatalan dicatat di audit log.

**Penutupan shift tidak pernah diblokir karena ada transaksi `PENDING`.** Kasir tidak boleh terjebak di akhir shift oleh transaksi yang bukan salahnya, dan memaksanya membersihkan satu per satu hanya akan berujung pada shift yang tidak ditutup sama sekali — yang jauh lebih buruk bagi rekonsiliasi kas.

Pembatalan ini aman tanpa efek samping karena **transaksi `PENDING` belum pernah menyentuh stok** (§8 dan `qris.md` §3.1) dan pembayarannya belum pernah `PAID`, sehingga tidak ada stok yang perlu dibalik dan tidak ada pengaruh ke `expectedCash`.

`GET /api/shifts/:id/summary` mengembalikan jumlah transaksi `PENDING` yang akan dibatalkan, dan layar tutup shift menampilkannya sebagai informasi sebelum kasir mengonfirmasi — bukan sebagai penghalang:

> *3 transaksi QRIS belum selesai akan dibatalkan saat shift ditutup.*

### 9.2 Void
Membatalkan transaksi utuh: stok kembali (reason `VOID`), pembayaran → `CANCELLED`, transaksi → `VOIDED`.

Syarat:
1. `businessDate == hari ini` (WIB), **dan**
2. **shift asalnya masih `OPEN`**, **dan**
3. transaksi belum pernah di-refund sebagian maupun penuh.

Syarat kedua adalah turunan langsung dari aturan "shift tertutup permanen": void mengubah penjualan tunai sebuah shift, jadi kalau shift sudah ditutup dan kasnya sudah direkonsiliasi, void akan merusak angka yang sudah dinyatakan final. Setelah tutup shift, koreksi harus lewat **refund** — yang membebani shift saat ini, bukan shift yang sudah selesai.

#### Tombol void yang tidak aktif harus menyebutkan alasannya

Tombol mati tanpa penjelasan membuat kasir menebak, lalu menelepon pemilik untuk hal yang sebenarnya sudah punya jawaban. Karena itu setiap kondisi punya pesan sendiri yang ditampilkan di tempat tombol berada:

| Kondisi | Pesan |
|---|---|
| Shift asal sudah ditutup | **"Shift sudah ditutup — gunakan refund"** |
| Transaksi bukan hari ini | **"Transaksi bukan hari ini — gunakan refund"** |
| Sudah pernah di-refund | **"Transaksi sudah pernah di-refund — gunakan refund untuk sisanya"** |
| Sudah di-void | **"Transaksi sudah dibatalkan"** |
| Transaksi belum selesai (`PENDING`) | **"Transaksi belum selesai — gunakan Batalkan"** |

Pesan ini **berasal dari server**, bukan disusun ulang di frontend. `GET /api/transactions/:id` mengembalikan `{ canVoid: boolean, voidBlockedReason: string | null }`, sehingga aturan dan penjelasannya punya satu sumber dan tidak bisa menyimpang dari yang benar-benar ditegakkan endpoint void.

#### Void atas pembayaran non-tunai yang sudah `PAID`

Kalau transaksi yang di-void dibayar QRIS dan pembayarannya sudah `PAID`, **uangnya sudah masuk ke rekening toko dan sistem ini tidak bisa menariknya kembali.** Void hanya membereskan pembukuan dan stok di sisi kita.

Dialog konfirmasi menampilkan peringatan eksplisit sebelum langkah PIN owner:

> ⚠️ **Uang QRIS sudah masuk ke rekening toko.**
> Void hanya membatalkan pencatatan dan mengembalikan stok. **Pengembalian uang ke pelanggan harus dilakukan manual oleh pemilik** lewat transfer atau tunai. Sistem tidak bisa menarik dana QRIS kembali.

Peringatan yang cuma ditutup lalu hilang tidak cukup untuk kewajiban uang, jadi audit log entri `VOID` menyimpan `paymentMethod` dan flag **`manualRefundRequired: true`** untuk kasus ini. Dashboard owner menampilkan daftar void yang masih menyisakan kewajiban pengembalian manual, sehingga kewajiban itu bisa ditelusuri, bukan bergantung pada ingatan orang yang menekan tombol.

### 9.3 Refund
Sebagian atau seluruh item, kapan saja. Stok kembali (reason `REFUND`). Dibebankan ke **shift tempat refund terjadi**, bukan shift penjualan asal, supaya uang keluar membebani laci yang benar.

- Guard kumulatif: Σ `refundedQty` per item ≤ `qty` asal. Dicek di dalam DB transaction.
- Nominal per item proporsional terhadap yang **benar-benar dibayar**: `lineFinal / qty × refundQty`, dengan largest remainder. Hasilnya: **refund penuh atas seluruh item == `netTotal` persis.** Diuji.
- HPP yang ikut kembali dihitung dan disimpan (`cogsAmount`), sehingga gross profit setelah refund benar.

Void dan refund **keduanya** butuh PIN owner (§7.3) dan tercatat di audit log dengan `beforeJson`/`afterJson`.

### 9.4 Barang masuk (restock)

Toko melakukan restock rutin, jadi stok harus bisa bertambah lewat jalur yang jujur — bukan menyalahgunakan `ADJUSTMENT` (yang artinya "koreksi kesalahan") atau `OPNAME` (yang artinya "hasil hitung fisik"). Reason yang berbeda menjaga laporan pergerakan stok tetap bisa dibaca: barang masuk karena beli itu peristiwa yang berbeda dari barang yang jumlahnya dikoreksi.

Form **"Barang masuk"** (owner, Fase 4): pilih produk → qty → harga beli baru (opsional).

```
POST /api/products/:id/stock-in   { qty, hargaBeli?, note? }

satu DB transaction:
  applyStockMovement(reason='PURCHASE', qtyChange=+qty, refType='PURCHASE')
  jika hargaBeli dikirim dan berbeda:
    Product.hargaBeli = nilai baru
    AuditLog COST_CHANGE  (beforeJson/afterJson)
  AuditLog PURCHASE_RECEIVED
```

Tanpa modul supplier, tanpa purchase order, tanpa nomor faktur. Satu produk per entri — bukan keterbatasan yang disembunyikan, tapi pilihan: satu entri per produk menghasilkan satu baris audit per produk, yang justru lebih mudah ditelusuri saat angka stok dipertanyakan nanti.

**Yang tidak berubah saat `hargaBeli` diperbarui:** HPP transaksi yang sudah terjadi. `TransactionItem.unitCost` adalah snapshot (§8, `reporting.md` §1.1), jadi memperbarui harga beli **tidak** menulis ulang laba kotor bulan lalu. Ini titik yang paling mudah rusak begitu restock jadi kegiatan rutin — tanpa snapshot, setiap kali harga beli naik, seluruh laporan historis ikut bergeser.

**Batas yang diakui:** `hargaBeli` diganti dengan **harga beli terakhir**, bukan rata-rata bergerak (moving average). Kalau toko membeli 10 unit @Rp 5.000 lalu 10 unit @Rp 6.000, seluruh 20 unit akan dihitung HPP Rp 6.000 saat dijual setelahnya. Ini menyederhanakan v1 secara sadar dan konsekuensinya dicatat di §19.

---

## 10. Penjadwalan laporan — catch-up adalah mekanisme utama

Server berjalan di laptop toko yang **dimatikan tiap malam**. Cron saja pasti melewatkan laporan.

### 10.1 Hook startup
**`instrumentation.ts` → `register()`** — satu-satunya titik "on server start" resmi di Next.js, berjalan di dev maupun production. Dijaga dari double-invocation (HMR dev, multi-worker) dengan flag global + baris lock di DB.

```
runStartupTasks():
  1. apply PRAGMA
  2. backup (VACUUM INTO)
  3. setelah delay singkat, non-blocking: catchUpReports(now)
```
Seluruhnya dibungkus try/catch: **kegagalan apa pun di sini tidak boleh membuat server gagal boot.** Toko harus bisa jualan walaupun backup gagal dan Discord mati.

#### Dua aturan yang tidak boleh dilanggar di file ini

Keduanya pernah dilanggar dan keduanya menimbulkan kerusakan senyap — lolos test, typecheck, lint, dan build, lalu gagal di runtime.

**1. File-nya harus di `src/instrumentation.ts`, bukan di root.** Project ini memakai folder `src/`, dan Next.js hanya mencarinya di sana. Di root, `register()` tidak pernah dipanggil, tanpa error apa pun — backup diam-diam tidak jalan.

**2. Import Node-only harus di dalam blok `if` positif.**

```ts
// BENAR — subtree Node-only benar-benar terbuang dari build non-Node
if (process.env.NEXT_RUNTIME === 'nodejs') {
  const { runStartupTasksOnce } = await import('./lib/startup')
  await runStartupTasksOnce()
}

// SALAH — webpack tetap menelusuri import ini
if (process.env.NEXT_RUNTIME !== 'nodejs') return
const { runStartupTasksOnce } = await import('./lib/startup')
```

Next.js mengompilasi file ini untuk runtime Node **dan** non-Node. Webpack mengganti `process.env.NEXT_RUNTIME` dengan literal lalu membuang cabang mati, tapi itu hanya bekerja andal untuk blok `if` yang tidak terambil — bukan untuk statement setelah `return`.

Bentuk yang salah membuat webpack menelusuri seluruh graph dan gagal meresolusi `node:fs`, `node:crypto`, serta `crypto` milik bcryptjs. Akibatnya **bukan** cuma startup yang mati: seluruh module graph gagal dibangun dan **setiap route menjawab 500**, termasuk yang sama sekali tidak menyentuh modul bermasalah.

**Turunannya:** apa pun yang bisa dijangkau dari `instrumentation.ts` harus bebas kriptografi. Karena itu `pruneExpiredSessions` dan `checkDatabase` tinggal di `src/lib/db/maintenance.ts` yang hanya berisi query Prisma polos — bukan di `auth/session.ts` yang menarik `bcryptjs` dan `node:crypto`.

### 10.2 `catchUpReports`
1. Hitung `today` di WIB.
2. Untuk setiap `kind` (DAILY/WEEKLY/MONTHLY) × `channel` yang terkonfigurasi: cari `periodKey` terakhir berstatus **`SENT`**. Kalau belum pernah, mulai dari `businessDate` transaksi paling awal (atau setting `installDate`).
3. Fungsi murni `missingPeriods(kind, lastSentKey, now, cap) → periodKey[]` menghasilkan semua periode terlewat, **hanya periode yang sudah selesai**. Hari ini yang belum berakhir tidak dikirim otomatis.
4. **Cap backlog** (default 60 periode, configurable) supaya laptop yang mati 6 bulan tidak mengirim 180 pesan bertubi-tubi.
5. Kirim **urut dari paling lama ke paling baru**, satu per satu, dengan jeda antar-kirim untuk menghormati rate limit.
6. Setiap kirim **diklaim** dengan insert `ReportDelivery` PENDING. Kena unique conflict `(kind, periodKey, channel)` → sudah pernah, lewati. Inilah satu-satunya penjaga anti-kirim-ganda.

### 10.3 Cron hanya optimisasi
Scheduler interval in-process (cek tiap 60 detik "ada yang jatuh tempo?") yang memanggil **fungsi `catchUpReports` yang sama persis**. Tidak ada jalur kode kedua, tidak ada logika terduplikasi. Kalau cron tidak pernah jalan, catch-up saat startup tetap menutup semuanya.

### 10.4 Test wajib
**"Server mati 3 hari"** — seed transaksi untuk 3 hari, set delivery terakhir ke D-4, jalankan catch-up dengan fake clock + fake provider. Assert: tepat 3 laporan harian terkirim **berurutan**, dan **run kedua tidak mengirim apa pun**.

---

## 11. Pengiriman laporan

```ts
interface NotificationProvider {
  readonly name: string
  isConfigured(): boolean
  send(message: ReportMessage): Promise<void>
}
```

`ReportMessage` adalah objek terstruktur provider-agnostic — `{ title, periodLabel, sections: {label, rows: {label, value}[]}[], aiInsight? }` — bukan string. Setiap provider memformat sendiri:

| Provider | Implementasi |
|---|---|
| `DiscordProvider` | Webhook, format embed |
| `TelegramProvider` | Bot API, parse mode HTML |
| `WhatsAppProvider` | **Stub** yang melempar `NotConfiguredError("WhatsApp belum dikonfigurasi")` |

WhatsApp sengaja stub: library unofficial seperti Baileys bisa membuat nomor toko diblokir, dan itu bukan risiko yang pantas diambil untuk sebuah laporan harian.

### Retry & kegagalan
- Exponential backoff + jitter, 5 percobaan (≈1s → 2s → 4s → 8s → 16s), menghormati `retry_after` pada HTTP 429 Discord.
- Gagal final → `status=FAILED` + `lastError`, di-log. **Tidak dilempar ke caller.**
- **Kegagalan notifikasi tidak pernah menggagalkan transaksi dan tidak pernah membuat aplikasi crash.**
- Semua pengiriman asinkron lewat queue in-process satu consumer (supaya tidak menghajar webhook). **Durabilitas ada di tabel `report_deliveries`, bukan di memori** — proses mati, item tetap `PENDING` dan dipungut catch-up berikutnya.
- Dashboard: daftar pengiriman gagal + tombol retry, plus tombol **"Kirim laporan sekarang"**.

### Status yang ditampilkan
UI hanya menampilkan keadaan nyata:
`Belum dikonfigurasi` / `Terkonfigurasi (belum diuji)` / `Terakhir berhasil <waktu>` / `Gagal: <alasan>`.

**Tidak pernah mengklaim "tersambung"** tanpa credential dan tanpa pengiriman yang benar-benar sukses. Ada tombol "Test kirim" yang benar-benar mengirim.

---

## 12. Gemini (opsional, default mati)

```
AI_ENABLED=false
GEMINI_API_KEY=
GEMINI_MODEL=
```

- **Maksimal 1 panggilan per hari**, hanya untuk laporan **mingguan** dan **bulanan**. Batas ditegakkan server-side lewat tabel `ai_call_logs` **sebelum** HTTP call apa pun. **Tidak pernah dipanggil per transaksi.**
- Input dibangun oleh `buildAiPayload(aggregate)` yang secara **konstruksi** hanya menerima angka agregat penjualan. Objek settings, credential, dan data pelanggan tidak punya jalur masuk — bukan karena disaring, tapi karena tipe fungsinya tidak menerimanya. (v1 juga tidak menyimpan data pelanggan sama sekali.)
- Output diminta sebagai **JSON terstruktur**, divalidasi Zod. Invalid → bagian AI **dilewati**, dicatat di `ai_call_logs` sebagai `ok=false`, laporan tetap terkirim. Tidak crash, dan **tidak ada baris `ai_insights` yang ditulis** — hanya hasil yang lolos validasi yang boleh tersimpan.

### 12.1 Penyimpanan teks AI

Hasil analisis **disimpan** di tabel `ai_insights`, supaya pemilik bisa membacanya ulang tanpa memanggil API lagi — penting karena batasnya 1 panggilan per hari.

Batas yang menjaga aturan "AI tidak boleh menulis ke database" tetap berlaku dalam arti yang sesungguhnya:

| Jaminan | Cara ditegakkan |
|---|---|
| AI tidak bisa mengubah harga, stok, transaksi, kas, atau setting | `ai_insights` **tidak punya satu pun relasi** ke tabel bisnis, dan tidak satu pun kolomnya dibaca oleh perhitungan penjualan/stok/kas/laporan |
| Teks AI tidak bisa berubah setelah tersimpan | Tabel **append-only** — analisis ulang membuat baris baru, tidak pernah `UPDATE`. Pembaca mengambil `createdAt` terbaru |
| Hanya keluaran yang valid yang tersimpan | Insert hanya terjadi setelah Zod parse berhasil |
| Tidak ada eksekusi dari teks AI | Keluaran diperlakukan sebagai **data untuk dibaca manusia**, ditampilkan sebagai teks, tidak pernah dievaluasi, tidak pernah dijadikan parameter query, dan tidak pernah memicu aksi |

Jadi yang dilarang adalah AI **mengubah data bisnis**, bukan menyimpan tulisannya sendiri di kandang yang terpisah. `ai_call_logs` tetap ada di samping `ai_insights`: ia mencatat panggilan yang gagal juga, yang dibutuhkan untuk penegakan batas harian dan penelusuran error.

Alur pembacaan: `POST /api/ai/insight` mengembalikan baris `ai_insights` terbaru untuk `(kind, periodKey)` kalau sudah ada — **tanpa memanggil API**. Hanya kalau belum ada, atau owner meminta refresh eksplisit, API dipanggil, dan panggilan itu tetap tunduk pada batas 1×/hari.

---

## 13. Struk & PWA

### Struk
Modul cetak dipisah dengan batas yang jelas:
```
buildReceipt(data) → ReceiptModel     (fungsi murni, bisa diuji)
       ↓
renderReceiptHtml(model)              (renderer — satu-satunya bagian yang ganti)
```
v1: tampilan print-friendly lewat printer browser/sistem di route `/struk/[id]`, dengan CSS `@media print` dan preset lebar 58mm / 80mm / A4 (setting `receiptWidth`).

**Driver thermal printer di luar scope v1.** Menambah renderer ESC/POS nanti cukup menambah satu fungsi `renderReceiptEscPos(model)` tanpa menyentuh logika struk maupun kode transaksi.

### PWA
Manifest + ikon + viewport + `display: standalone` → installable, bekerja baik di layar sentuh dan layar kecil. Target sentuh minimal 44px di seluruh layar kasir.

**Tanpa service worker caching di v1**, dan ini keputusan sadar: cache SW membawa risiko kode basi (kasir menjalankan versi lama tanpa sadar) dengan **nol manfaat**, karena aplikasi memang tidak bisa berfungsi tanpa server LAN. Konsisten dengan §1.1.

---

## 14. Daftar route

### Halaman
| Route | Akses | Isi |
|---|---|---|
| `/login` | publik | Pilih user → PIN pad |
| `/` | auth | Redirect: cashier → `/kasir`, owner → `/dashboard` |
| `/kasir` | both | Layar POS 2 kolom; modal bayar tunai & QRIS |
| `/struk/[transactionId]` | both | Print view (58mm / 80mm / A4) |
| `/shift` | both | Buka/tutup shift + preview expected cash |
| `/pengeluaran` | both | List + input pengeluaran |
| `/transaksi` | both | Riwayat, pencarian |
| `/transaksi/[id]` | both | Detail + aksi void/refund (PIN owner) |
| `/produk` | owner | List, CRUD |
| `/produk/[id]` | owner | Edit, penyesuaian stok, riwayat stok |
| `/laporan` | owner | Viewer harian/mingguan/bulanan + date picker |
| `/dashboard` | owner | Ringkasan, status pengiriman, kirim manual, minta analisis |
| `/pengaturan` | owner | Toko, QRIS, notifikasi, backup/export |
| `/pengaturan/pengguna` | owner | User & PIN |
| `/audit` | owner | Audit log viewer |

### API

**Auth & user**
```
POST   /api/auth/login                    { userId, pin }
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/users                         (login page: daftar nama+id saja, tanpa hash)
POST   /api/users                         owner
PATCH  /api/users/:id                     owner — ganti PIN, aktif/nonaktif (tidak ada DELETE)
```

**Produk & stok**
```
GET    /api/products?q=&kategori=&aktif=&cursor=
GET    /api/products/lookup?barcode=      lookup tunggal cepat untuk scanner
POST   /api/products                      owner
PATCH  /api/products/:id                  owner — perubahan harga → audit PRICE_CHANGE
POST   /api/products/:id/stock-adjustment owner — { qtyChange | newQty, reason, note }
POST   /api/products/:id/stock-in         owner — { qty, hargaBeli?, note } → reason PURCHASE
GET    /api/products/:id/stock-movements  riwayat pergerakan stok
POST   /api/products/:id/image            owner — upload
GET    /api/uploads/[...path]             serve gambar (validasi path, anti traversal)
```

**Transaksi**
```
POST   /api/transactions                  CASH → settle di DB txn yang sama; QRIS → PENDING
GET    /api/transactions?date=&shiftId=&q=&cursor=
GET    /api/transactions/:id
POST   /api/transactions/:id/void         PIN owner
POST   /api/transactions/:id/refunds      PIN owner
```

**Pembayaran**
```
POST   /api/payments/:id/confirm          settle — kasir boleh (QRIS manual), tanpa body
                                          satu-satunya jalan menuju PAID untuk QRIS statis
POST   /api/payments/:id/cancel           { reason? } — hanya dari PENDING
GET    /api/payments/:id/status            HANYA membaca; tidak pernah melunaskan
```

**Shift & pengeluaran**
```
GET    /api/shifts/current
POST   /api/shifts/open                   { openingCash }
GET    /api/shifts/:id/summary            expected cash dihitung, bukan disimpan
POST   /api/shifts/:id/close              { countedCash, notes }
GET    /api/expenses?date=&shiftId=
POST   /api/expenses
DELETE /api/expenses/:id                  PIN owner, hanya selama shift-nya OPEN (soft delete)
```

**Laporan & AI**
```
GET    /api/reports/daily?date=YYYY-MM-DD
GET    /api/reports/weekly?week=YYYY-Www
GET    /api/reports/monthly?month=YYYY-MM
POST   /api/reports/send                  { kind, periodKey, channels? } → trigger=MANUAL
GET    /api/reports/deliveries?status=&trigger=
POST   /api/reports/deliveries/:id/retry
POST   /api/ai/insight                    owner — { kind, periodKey, refresh? }
                                          tanpa refresh: kembalikan ai_insights terbaru
                                          tanpa memanggil API sama sekali
```

**Operasional**
```
GET    /api/settings                      owner — secret ter-mask
PATCH  /api/settings                      owner + PIN owner — { ownerPin, values }
                                          audit SETTING_CHANGE per key, secret ter-mask
POST   /api/settings/qris-image           owner + PIN owner — multipart { ownerPin, file }
                                          tipe ditentukan dari magic bytes, bukan nama berkas
POST   /api/backup                        owner
GET    /api/export/csv                    owner — stream zip
GET    /api/audit-logs?action=&from=&to=  owner (read-only, tanpa PATCH/DELETE)
GET    /api/health                        db ok, pending deliveries, last backup
```

---

## 15. Backup & integritas

### Metode: `VACUUM INTO`, bukan copy file
```sql
VACUUM INTO 'C:/.../backups/pos-20260918-214530.db';
```
Ini menghasilkan snapshot **konsisten** dalam satu file, benar walaupun mode WAL aktif dan ada kasir sedang menulis. Menyalin `pos.db` mentah saat WAL aktif bisa menghasilkan backup yang rusak atau ketinggalan transaksi terakhir — karena sebagian data masih ada di file `-wal`.

- Dijalankan otomatis **setiap app start** dan **setiap tutup shift**.
- Simpan **30 salinan terbaru** dengan nama bertanggal, sisanya dipangkas.
- **Gagal backup tidak boleh crash server** — di-log, ditampilkan di health/dashboard.
- Tombol **"Backup sekarang"** dan **"Export semua data ke CSV"** (zip: products, transactions, transaction_items, payments, refunds, refund_items, expenses, shifts, stock_movements, audit_logs).
- Opsional `BACKUP_MIRROR_DIR` — salin backup terbaru ke folder lain (USB, atau folder Google Drive yang tersinkron).

**Backup di disk yang sama tidak melindungi dari hard disk mati, laptop hilang, atau ransomware.** Ini toko sungguhan, jadi mirror ke USB/cloud sangat disarankan dan ditulis jujur di README, bukan diklaim aman.

Cara restore ditulis di README dengan bahasa orang non-teknis: tutup aplikasi → salin file backup menjadi `data/pos.db` → hapus `pos.db-wal` dan `pos.db-shm` → nyalakan lagi.

### Logging
Logger sederhana ke console **dan** `data/logs/app-YYYYMMDD.log` (simpan 14 hari). Di laptop toko, jendela terminal sering tertutup — tanpa file log, error yang dilaporkan karyawan tidak bisa ditelusuri.

---

## 16. Audit log

Append-only **secara desain**: tidak ada endpoint UPDATE maupun DELETE untuk tabel `audit_logs`. Kasir tidak bisa menghapusnya karena jalurnya tidak ada, bukan karena tombolnya disembunyikan.

Action yang dicatat:
```
LOGIN, LOGIN_FAILED, LOGOUT,
SHIFT_OPEN, SHIFT_CLOSE, PENDING_CANCELLED_ON_SHIFT_CLOSE,
PAYMENT_CONFIRM, PAYMENT_CANCEL, VOID, REFUND,
PRICE_CHANGE, COST_CHANGE, PURCHASE_RECEIVED,
PRODUCT_CREATE, PRODUCT_UPDATE, STOCK_ADJUSTMENT,
EXPENSE_DELETE,
SETTING_CHANGE, USER_CREATE, USER_UPDATE,
BACKUP_RUN, REPORT_SEND_MANUAL, AI_INSIGHT_REQUEST
```
`PRICE_CHANGE` untuk `hargaJual`, `COST_CHANGE` untuk `hargaBeli` — dipisah karena keduanya punya arti berbeda bagi pemilik: yang pertama mempengaruhi harga yang dilihat pelanggan, yang kedua mempengaruhi laba kotor penjualan berikutnya.
Perubahan data menyertakan `beforeJson` dan `afterJson`. Pembuatan transaksi normal **tidak** dicatat di audit log — transaksi sudah menjadi catatannya sendiri, dan mencatatnya dua kali hanya membuat audit log penuh derau sehingga hal yang benar-benar penting tenggelam.

---

## 17. Rencana implementasi bertahap

Setiap fase berakhir dalam kondisi **bisa dijalankan**, dan wajib lulus `npm run test` + `npm run typecheck` + `npm run lint` + `npm run build`. Tidak lanjut ke fase berikutnya kalau ada yang merah. Tidak meninggalkan project dengan build rusak.

| Fase | Isi | Definition of done |
|---|---|---|
| **0** | Install Node LTS. Tulis `architecture.md`, `database.md`, `reporting.md`, `qris.md`. | Dokumen di-review pemilik. **Belum ada kode aplikasi.** |
| **1** | Scaffold Next+TS+Tailwind. Prisma schema lengkap + migration. PRAGMA + client singleton. Seed: 1 owner, 2 kasir, 20 produk. Login PIN + session + rate limit + audit. Modul `money/` + `time/` + test. **`instrumentation.ts` + backup otomatis `VACUUM INTO` saat startup + prune 30.** `.env.example`, `.gitignore`, script LAN. | Bisa login dari HP lain di WiFi yang sama; `backups/` terisi setiap kali server dinyalakan |
| **2** | Layar kasir 2 kolom, sentuh ≥44px. Pencarian nama/SKU/barcode. Scanner barcode langsung bekerja. Qty, hapus, diskon item & transaksi. Bayar tunai + kembalian + tombol cepat. Checkout atomic + stok + `stock_movements`. Struk print. Auto-reset keranjang. Modul `cart/`, `payment/`, `receipt/`. | Transaksi tunai penuh dari scan sampai struk; test rollback & test race stok lulus |
| **3** | Buka/tutup shift, preview expected cash, simpan selisih, shift tertutup permanen. **Auto-cancel transaksi `PENDING` saat tutup shift + backup saat tutup shift.** Pengeluaran + kategori. Blokir checkout tanpa shift. Modul `shift/`. | Rekonsiliasi kas satu hari penuh bisa dijalankan |
| **4** | Void (hari sama + shift OPEN) **+ pesan alasan saat tombol mati + peringatan QRIS `PAID`**, refund sebagian/penuh + alokasi teleskopik, PIN owner server-side. Audit log viewer. CRUD produk, upload gambar, penyesuaian stok + `OPNAME`, **form "Barang masuk" (reason `PURCHASE`) + audit `COST_CHANGE`**, audit perubahan harga. Modul `refund/`. | Refund penuh == netTotal persis; semua aksi muncul di audit; stok bisa bertambah lewat barang masuk |
| **5** | `PaymentProvider` + `StaticQrisProvider` + registry. State machine bergerbang. Upload gambar QR. Finalisasi `qris.md`. | Double-confirm ditolak; tidak ada PAID tanpa aksi manusia |
| **6** | Agregasi harian/mingguan/bulanan murni + `/laporan`. Catch-up di `instrumentation.ts` + scheduler interval. Discord + Telegram + WhatsApp stub + backoff + `report_deliveries` idempotent (`trigger` AUTO/MANUAL). Kirim manual & retry. | **Test "server mati 3 hari" + test idempotensi lulus; kirim manual 2× tidak error** |
| **7** | Mirror backup opsional. Tombol "Backup sekarang" & export CSV. Dashboard owner (termasuk daftar void yang butuh pengembalian manual). README lengkap: cara nyala, cari IP LAN, izin Windows Firewall, `start-toko.bat`, **cara restore untuk orang non-teknis**. | Prosedur restore dijalankan dari awal sampai akhir dan data kembali |
| **8** | Gemini: batas 1×/hari, hanya mingguan/bulanan, payload agregat whitelisted, Zod, skip kalau invalid, simpan ke `ai_insights` (append-only), tombol "Minta analisis" + baca cache tanpa panggil API. | Lulus dengan `AI_ENABLED=false` dan dengan response invalid; insight tersimpan bisa dibaca ulang offline |

---

## 17a. Lapisan test, dan apa yang TIDAK bisa dilihat masing-masing

Fase 2 lolos `test` + `typecheck` + `lint` + `build`, lalu setiap route menjawab 500 begitu server dijalankan. Bukan karena testnya kurang banyak, melainkan karena tidak satu pun dari keempatnya menyentuh lapisan yang rusak.

| Lapisan | Yang diuji | Yang TIDAK bisa dilihat |
|---|---|---|
| **Unit** (`src/lib/**/*.test.ts`) | Matematika uang, waktu, state machine. Cepat, tanpa IO | Database, bundler, HTTP |
| **Integrasi DB** (`tests/checkout.test.ts`, `tests/qris.test.ts`, `tests/db-integrity.test.ts`) | Atomicity, race, rollback, constraint. Memanggil fungsi service langsung | **Bundler dan route handler** — kode bisa benar tapi tidak pernah bisa dimuat Next.js |
| **HTTP** (`tests/api-http.test.ts`, `tests/e2e-shift-refund.test.ts`, `tests/e2e-qris.test.ts`) | Server Next.js sungguhan: bundling, auth, Zod, status code, envelope error | Perilaku browser (klik, fokus, scanner) |
| **Bentuk kode** (`src/lib/payment/no-auto-success.test.ts`) | Larangan struktural: tidak ada timer di jalur pembayaran, hanya satu berkas yang menulis `paidAt` | Apakah logikanya benar — ia hanya menjaga bentuknya |
| **Manual browser** | Interaksi kasir sungguhan | — |

Lapisan HTTP adalah yang paling mahal dan paling sering dilewati, dan justru satu-satunya yang bisa melihat kegagalan bundling. `tests/api-http.test.ts` menjalankan `next dev` sungguhan terhadap SQLite sementara, lalu menembak request nyata.

Test pertamanya sengaja hanya memeriksa `GET /api/health` menjawab 200. Terlihat sepele, tapi itulah kanarinya: saat module graph rusak, **semua** route menjawab 500 sekaligus, dan satu assertion itu langsung menangkapnya.

**Aturan yang diambil dari kejadian ini:** setiap endpoint yang menyentuh uang wajib punya test di lapisan HTTP, bukan cukup di lapisan service.

---

## 18. Operasional di toko

- Laptop server sebaiknya diberi **IP statis** (atau DHCP reservation di router), supaya alamat yang dihafal karyawan tidak berubah.
- `npm run build && npm run start` untuk pemakaian harian, **bukan** `npm run dev`.
- `start-toko.bat` untuk dobel-klik: jalankan server lalu buka browser.
- Windows Firewall akan bertanya saat pertama kali — harus **Allow** pada jaringan Private, kalau tidak device lain tidak bisa mengakses.
- Cari IP LAN: `ipconfig` → `IPv4 Address` pada adapter WiFi. Kasir mengakses `http://<IP>:3000`.

### 18.1 `Cannot find module './vendor-chunks/....js'`

Gejalanya menyesatkan: sepertinya ada dependensi yang hilang, padahal `node_modules` baik-baik saja. Yang rusak adalah **folder build**.

`next dev` dan `next build` sama-sama menulis ke `.next`, dan keduanya menghasilkan struktur chunk yang berbeda. Menjalankan `npm run build` saat `npm run dev` masih hidup membuat isinya tercampur: manifest dari dev menunjuk ke chunk yang hanya dibuat build, atau sebaliknya.

Penanganannya:

```bash
npm run build
```

didahului menghentikan dev server, lalu hapus `.next` dan jalankan lagi:

```bash
rm -rf .next
```

**Aturan:** jangan menjalankan `build` saat `dev` berjalan, dan sebaliknya. Kalau terlanjur, hapus `.next` — tidak ada data toko di sana, isinya murni hasil kompilasi.

`tests/api-http.test.ts` menjalankan `next dev` sungguhan, jadi ia memakai folder build sendiri lewat `NEXT_DIST_DIR=.next-test` dan **tidak pernah** merusak dev server yang sedang dipakai.

---

## 19. Batas yang diakui terbuka

Ditulis di sini supaya tidak ada yang mengira sudah selesai:

- **Driver thermal printer di luar scope v1.** Hanya print browser, dengan batas modul yang siap diganti (§13).
- **Provider QRIS dinamis belum ada.** v1 memakai QR statis + konfirmasi manual kasir. Tidak ada integrasi Midtrans/Xendit, dan tidak diklaim ada.
- **Stok opname penuh** (sesi hitung fisik terpandu) belum ada; v1 hanya penyesuaian per produk dengan reason `OPNAME`.
- **Tanpa TLS di LAN**, jadi cookie tanpa flag `secure` (§7.1).
- **Backup di disk yang sama** tidak melindungi dari kerusakan disk atau kehilangan laptop (§15).
- **Ceiling `Int` 32-bit Rp 2,1 miliar** per kolom nominal; agregasi memakai JS `number` sehingga tidak terpengaruh (§4).
- **HPP memakai harga beli terakhir, bukan rata-rata bergerak** (§9.4). Setelah restock dengan harga lebih tinggi, stok lama ikut dihitung dengan harga baru saat dijual. Laba kotor jadi sedikit konservatif saat harga naik dan sedikit optimistis saat harga turun.
- **Void atas QRIS yang sudah `PAID` tidak menarik dana.** Sistem tidak punya jalan ke rekening; pengembalian ke pelanggan dilakukan manual oleh pemilik (§9.2). Kewajiban ini dilacak di dashboard, bukan diselesaikan otomatis.
- **Tidak ada data pelanggan** di v1 — tanpa membership, tanpa piutang.
- **Tidak ada multi-satuan / konversi satuan** (misal beli per dus, jual per pcs) di v1.
- **Sistem harus tetap berfungsi penuh saat internet, Discord, Telegram, dan Gemini semuanya mati.** Ini diuji secara eksplisit, bukan diasumsikan.
