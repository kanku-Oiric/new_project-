# Database — Sistem Kasir Toko

> Status: **Draft untuk review.** Pendamping `architecture.md`.

SQLite via Prisma, file `data/pos.db`. `DATABASE_URL="file:../data/pos.db"` (relatif terhadap folder `prisma/`).

---

## 1. Batasan Prisma + SQLite yang harus diketahui sebelum menulis schema

Ini ditulis lebih dulu karena keempat hal berikut akan menabrak dinding di tengah migration kalau baru ditemukan nanti.

### 1.1 `enum` tidak didukung SQLite di Prisma
Blok `enum` hanya tersedia untuk PostgreSQL / MySQL / MongoDB. Semua status di sini adalah kolom **`String`**, dengan TypeScript union + Zod enum sebagai **satu-satunya sumber kebenaran**:

```ts
export const ROLE = ['OWNER', 'CASHIER'] as const
export const RoleSchema = z.enum(ROLE)
export type Role = z.infer<typeof RoleSchema>
```
Setiap penulisan ke kolom status harus lewat nilai bertipe ini, sehingga typo tidak mungkin lolos ke DB. Comment `// "OWNER" | "CASHIER"` di schema hanya dokumentasi untuk pembaca.

### 1.2 Tipe `Json` tidak ada
`beforeJson` / `afterJson` di audit log adalah `String` hasil `JSON.stringify`. Dibaca dengan `JSON.parse` + Zod, bukan `as any`.

### 1.3 `mode: 'insensitive'` tidak didukung
Pencarian case-insensitive Prisma hanya untuk PostgreSQL/MongoDB. Karena itu `Product` punya kolom **`searchKey`**: gabungan lowercase dari `nama + sku + barcode`, dan query memakai needle yang sudah di-lowercase. Deterministik, tidak bergantung collation SQLite, dan tidak tergantung perilaku `LIKE` yang hanya case-insensitive untuk ASCII.

`searchKey` di-regenerasi di satu tempat saja (`buildSearchKey(product)`) setiap kali produk dibuat/diubah.

### 1.4 Partial unique index tidak ada
Aturan **"satu shift `OPEN` per kasir"** tidak bisa ditulis sebagai `CREATE UNIQUE INDEX ... WHERE status='OPEN'` lewat Prisma.

Solusinya kolom **`openKey String? @unique`**:
- Saat shift dibuka → `openKey = cashierId`
- Saat shift ditutup → `openKey = null`

SQLite mengizinkan **banyak NULL** pada kolom unique, jadi shift tertutup sebanyak apa pun tidak bertabrakan, sementara kasir yang sama tidak mungkin punya dua shift terbuka. Aturannya ditegakkan **database**, bukan cuma kode aplikasi — dua device yang menekan "Buka shift" bersamaan tidak bisa lolos keduanya.

**Pola yang sama dipakai di `ReportDelivery.dedupeKey`** untuk membedakan pengiriman otomatis (yang harus unik per periode) dari pengiriman manual (yang boleh berulang) — lihat §3 dan `reporting.md` §6.2.

### 1.5 `RETURNING` dan `VACUUM INTO`
- `UPDATE ... RETURNING` butuh SQLite ≥ 3.35 dan diakses lewat **`$queryRaw`** (`$executeRaw` hanya mengembalikan jumlah baris). Fallback: `UPDATE` lalu `SELECT` dalam transaction yang sama.
- `VACUUM INTO` butuh SQLite ≥ 3.27, dijalankan lewat `$executeRawUnsafe` dengan **path absolut**, dan file tujuan **harus belum ada**.

---

## 2. Konvensi

| Hal | Aturan |
|---|---|
| Primary key | UUID (`String @id @default(uuid())`) — semua tabel |
| Nomor manusia | Kolom terpisah (`trxNumber`, `refundNumber`), `@unique` |
| Uang | `Int`, rupiah penuh. Tidak ada Float/Decimal. Ceiling Rp 2.147.483.647 |
| Timestamp | `DateTime`, disimpan UTC |
| Hari usaha | `businessDate String` `"YYYY-MM-DD"` WIB, didenormalisasi |
| Status | `String` + Zod enum (§1.1) |
| Nama kolom | camelCase (domain istilah Indonesia dipertahankan: `nama`, `hargaJual`, `stok`, `satuan`) |
| Delete | Hampir tidak ada. User & produk dinonaktifkan; pengeluaran soft delete; transaksi di-void; audit log tidak bisa dihapus |

**Invariant penting:** **user tidak pernah dihapus**, hanya `active=false`. Karena itu kolom *actor stamp* (`voidedByUserId`, `authorizedByUserId`, `confirmedByUserId`, `deletedByUserId`, `closedByUserId`, `updatedByUserId`) disimpan sebagai `String?` biasa **tanpa** relasi Prisma. Alasannya: kolom-kolom itu hanya cap sejarah "siapa melakukan", tidak pernah bisa dangling karena user tak terhapus, dan mendefinisikan 6 relasi tambahan hanya akan menambah belasan back-relation di model `User` tanpa menjamin apa pun. Relasi Prisma penuh dipakai untuk kolom yang memang di-join dan di-traverse.

---

## 3. Skema lengkap

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────── AUTH & USER ───────────────────────────────

model User {
  id             String    @id @default(uuid())
  name           String
  role           String    // "OWNER" | "CASHIER"
  pinHash        String
  active         Boolean   @default(true)
  mustChangePin  Boolean   @default(false)
  failedAttempts Int       @default(0)
  lockedUntil    DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  sessions     Session[]
  shifts       Shift[]
  transactions Transaction[]

  @@index([active])
}

model Session {
  id         String   @id          // sha256(token) — token asli hanya ada di cookie
  userId     String
  createdAt  DateTime @default(now())
  expiresAt  DateTime
  lastSeenAt DateTime @default(now())
  deviceLabel String?
  ip         String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}

// ─────────────────────────────── SETTINGS ───────────────────────────────

model Setting {
  key             String   @id
  value           String                 // selalu string; di-parse per key lewat Zod
  updatedAt       DateTime @updatedAt
  updatedByUserId String?
}

// ─────────────────────────────── PRODUK & STOK ───────────────────────────────

model Product {
  id          String   @id @default(uuid())
  sku         String   @unique
  barcode     String?  @unique          // nullable; SQLite izinkan banyak NULL di unique
  nama        String
  searchKey   String                    // lowercase(nama + ' ' + sku + ' ' + barcode)
  kategori    String
  hargaBeli   Int                       // HPP saat ini, rupiah
  hargaJual   Int                       // rupiah
  stok        Int      @default(0)
  stokMinimum Int      @default(0)
  satuan      String   @default("pcs")
  aktif       Boolean  @default(true)
  gambarPath  String?                   // relatif terhadap data/uploads/
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  transactionItems TransactionItem[]
  stockMovements   StockMovement[]

  @@index([searchKey])
  @@index([kategori])
  @@index([aktif])
  @@index([barcode])
}

model StockMovement {
  id           String   @id @default(uuid())
  productId    String
  qtyChange    Int                       // BERTANDA: negatif = keluar, positif = masuk
  reason       String                    // "SALE"|"REFUND"|"VOID"|"PURCHASE"|"ADJUSTMENT"|"OPNAME"|"INITIAL"
  stockBefore  Int
  stockAfter   Int
  refType      String?                   // "TRANSACTION"|"REFUND"|"PURCHASE"|"MANUAL"
  refId        String?
  userId       String
  note         String?
  businessDate String
  createdAt    DateTime @default(now())

  product Product @relation(fields: [productId], references: [id], onDelete: Restrict)

  @@index([productId, createdAt])
  @@index([businessDate])
  @@index([reason])
  @@index([refType, refId])
}

// ─────────────────────────────── SHIFT ───────────────────────────────

model Shift {
  id           String    @id @default(uuid())
  cashierId    String
  status       String                    // "OPEN" | "CLOSED"
  openKey      String?   @unique         // = cashierId saat OPEN, null saat CLOSED (§1.4)
  openedAt     DateTime  @default(now())
  closedAt     DateTime?
  openingCash  Int
  countedCash  Int?
  expectedCash Int?
  difference   Int?                      // countedCash - expectedCash
  businessDate String
  notes        String?
  closedByUserId String?

  cashier      User          @relation(fields: [cashierId], references: [id], onDelete: Restrict)
  transactions Transaction[]
  refunds      Refund[]
  expenses     Expense[]

  @@index([cashierId, status])
  @@index([businessDate])
  @@index([status])
}

// ─────────────────────────────── TRANSAKSI ───────────────────────────────

model Transaction {
  id                String    @id @default(uuid())
  trxNumber         String    @unique    // "TRX-20260918-000123"
  businessDate      String
  shiftId           String
  cashierId         String
  status            String              // "PENDING"|"COMPLETED"|"VOIDED"|"CANCELLED"

  grossSubtotal      Int                // Σ (unitPrice × qty), sebelum diskon apa pun
  itemDiscountTotal  Int                // Σ itemDiscount
  transactionDiscount Int               // diskon level transaksi (rupiah)
  netTotal           Int                // grossSubtotal − itemDiscountTotal − transactionDiscount
  cogsTotal          Int                // Σ (unitCost × qty)

  note           String?
  createdAt      DateTime  @default(now())
  completedAt    DateTime?
  voidedAt       DateTime?
  voidedByUserId String?
  voidReason     String?

  shift    Shift             @relation(fields: [shiftId], references: [id], onDelete: Restrict)
  cashier  User              @relation(fields: [cashierId], references: [id], onDelete: Restrict)
  items    TransactionItem[]
  payments Payment[]
  refunds  Refund[]

  @@index([businessDate, status])
  @@index([shiftId])
  @@index([createdAt])
  @@index([status])
}

model TransactionItem {
  id            String @id @default(uuid())
  transactionId String
  productId     String

  // ── SNAPSHOT saat penjualan — tidak boleh berubah walau produk diubah besok ──
  productName String
  sku         String
  unitPrice   Int                        // = hargaJual saat jual
  unitCost    Int                        // = hargaBeli saat jual (dasar HPP)

  qty                 Int
  lineGross           Int                // unitPrice × qty
  itemDiscount        Int  @default(0)
  allocatedTxDiscount Int  @default(0)   // bagian transactionDiscount (largest remainder)
  lineNet             Int                // lineGross − itemDiscount
  lineFinal           Int                // lineNet − allocatedTxDiscount — DASAR NOMINAL REFUND
  refundedQty         Int  @default(0)   // akumulatif, guard refund berlebih
  refundedAmount      Int  @default(0)   // akumulatif, dasar rumus refund teleskopik

  transaction Transaction  @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  product     Product      @relation(fields: [productId], references: [id], onDelete: Restrict)
  refundItems RefundItem[]

  @@index([transactionId])
  @@index([productId])
}

model Payment {
  id             String    @id @default(uuid())
  transactionId  String
  method         String                  // "CASH" | "QRIS_STATIC"
  status         String                  // "PENDING"|"PAID"|"EXPIRED"|"CANCELLED"|"FAILED"
  amount         Int                     // nominal yang harus dibayar (= netTotal untuk pembayaran tunggal)
  amountTendered Int?                    // uang diserahkan (tunai)
  changeAmount   Int?                    // kembalian
  providerName   String                  // "cash" | "qris-static" | nanti "midtrans" dst
  externalId     String?
  qrRef          String?                 // path/identitas QR yang ditampilkan
  failureReason  String?
  createdAt      DateTime  @default(now())
  paidAt         DateTime?
  confirmedByUserId String?

  transaction Transaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)

  @@index([transactionId])
  @@index([status])
  @@index([externalId])
}

// ─────────────────────────────── REFUND ───────────────────────────────

model Refund {
  id            String   @id @default(uuid())
  refundNumber  String   @unique         // "RFN-20260918-000045"
  transactionId String
  shiftId       String                   // shift tempat REFUND terjadi, bukan shift penjualan asal
  businessDate  String                   // tanggal refund
  amount        Int                      // Σ RefundItem.amount
  cogsAmount    Int                      // Σ RefundItem.cogsAmount
  method        String                   // "CASH"|"QRIS_MANUAL"|"OTHER"
  reason        String
  authorizedByUserId String              // owner yang memberi PIN
  createdByUserId    String              // kasir yang menjalankan
  createdAt     DateTime @default(now())

  transaction Transaction  @relation(fields: [transactionId], references: [id], onDelete: Restrict)
  shift       Shift        @relation(fields: [shiftId], references: [id], onDelete: Restrict)
  items       RefundItem[]

  @@index([transactionId])
  @@index([shiftId])
  @@index([businessDate])
}

model RefundItem {
  id                String @id @default(uuid())
  refundId          String
  transactionItemId String
  qty               Int
  amount            Int                  // proporsional terhadap lineFinal
  cogsAmount        Int                  // unitCost × qty

  refund          Refund          @relation(fields: [refundId], references: [id], onDelete: Cascade)
  transactionItem TransactionItem @relation(fields: [transactionItemId], references: [id], onDelete: Restrict)

  @@index([refundId])
  @@index([transactionItemId])
}

// ─────────────────────────────── PENGELUARAN ───────────────────────────────

model Expense {
  id              String    @id @default(uuid())
  shiftId         String
  businessDate    String
  kategori        String
  amount          Int
  note            String?
  paidFrom        String    @default("CASH_DRAWER")  // "CASH_DRAWER" | "OTHER"
  createdByUserId String
  createdAt       DateTime  @default(now())
  deletedAt       DateTime?                          // soft delete
  deletedByUserId String?

  shift Shift @relation(fields: [shiftId], references: [id], onDelete: Restrict)

  @@index([shiftId])
  @@index([businessDate])
  @@index([deletedAt])
}

// ─────────────────────────────── AUDIT ───────────────────────────────

model AuditLog {
  id         String   @id @default(uuid())
  at         DateTime @default(now())
  userId     String?
  actorRole  String?
  action     String
  entityType String?
  entityId   String?
  summary    String
  beforeJson String?
  afterJson  String?
  ip         String?
  deviceLabel String?

  @@index([at])
  @@index([action])
  @@index([entityType, entityId])
  @@index([userId])
}

// ─────────────────────────────── OPERASIONAL ───────────────────────────────

model DailyCounter {
  scope   String @id                     // "TRX-20260918" | "RFN-20260918"
  lastSeq Int    @default(0)
}

model ReportDelivery {
  id            String    @id @default(uuid())
  kind          String                   // "DAILY"|"WEEKLY"|"MONTHLY"
  periodKey     String                   // "2026-09-18" | "2026-W38" | "2026-09"
  channel       String                   // "DISCORD"|"TELEGRAM"
  trigger       String                   // "AUTO" (cron/catch-up) | "MANUAL" (tombol)
  status        String                   // "PENDING"|"SENT"|"FAILED"
  attempts      Int       @default(0)
  lastError     String?
  nextAttemptAt DateTime?
  createdAt     DateTime  @default(now())
  sentAt        DateTime?
  requestedByUserId String?              // hanya untuk trigger MANUAL

  // "kind|periodKey|channel" saat trigger=AUTO, null saat trigger=MANUAL.
  // Unique atas kolom nullable = AUTO terdedup, MANUAL boleh berulang (§1.4).
  dedupeKey     String?   @unique

  @@index([status, nextAttemptAt])
  @@index([kind, periodKey, channel, trigger])
  @@index([trigger, status])
}

model AiCallLog {
  id           String   @id @default(uuid())
  at           DateTime @default(now())
  businessDate String                    // untuk penegakan batas 1×/hari
  kind         String                    // "WEEKLY"|"MONTHLY"
  periodKey    String
  ok           Boolean
  model        String?
  errorMessage String?

  @@index([businessDate])
}

/// Teks saran AI yang tersimpan, supaya bisa dibaca ulang tanpa memanggil API lagi.
/// TIDAK punya relasi tulis ke tabel bisnis mana pun, dan tidak satu pun kolomnya
/// dipakai dalam perhitungan penjualan, stok, kas, atau laporan. Murni bacaan.
model AiInsight {
  id                String   @id @default(uuid())
  kind              String                // "WEEKLY"|"MONTHLY"
  periodKey         String
  model             String                // model yang menghasilkan
  insightJson       String                // hasil yang SUDAH lolos validasi Zod
  createdAt         DateTime @default(now())
  requestedByUserId String?

  @@index([kind, periodKey, createdAt])
  @@index([createdAt])
}

model StartupLock {
  id        String   @id                 // "catchup" | "backup"
  holder    String                       // pid/uuid proses
  heldAt    DateTime
  expiresAt DateTime
}
```

---

## 4. Relasi

```
User ──┬─< Session
       ├─< Shift ──┬─< Transaction ──┬─< TransactionItem ──< RefundItem
       │           │                 └─< Payment              ^
       │           ├─< Refund ───────────< RefundItem ────────┘
       │           └─< Expense
       └─< Transaction (cashier)

Product ──┬─< TransactionItem
          └─< StockMovement

(tanpa relasi keluar, sengaja)
AuditLog   DailyCounter   ReportDelivery   AiCallLog   AiInsight   Setting   StartupLock
```

`AiInsight` sengaja **tidak** punya relasi ke tabel mana pun, dan itu justru jaminannya: tidak ada jalur dari keluaran AI ke produk, harga, stok, transaksi, kas, atau setting. Ia hanya bisa dibaca. Tabel ini juga **append-only** — analisis ulang untuk periode yang sama menghasilkan baris baru, bukan `UPDATE`, dan pembaca mengambil `createdAt` terbaru. Sebuah upsert akan berarti baris AI bisa berubah, yang bertentangan dengan sifat read-only yang diminta.

`AiCallLog` tetap ada dan tidak digantikan `AiInsight`: ia mencatat panggilan yang **gagal** juga (untuk penegakan batas 1×/hari dan penelusuran error), sedangkan `AiInsight` hanya berisi hasil yang berhasil dan lolos Zod.

`AuditLog` sengaja tanpa foreign key ke tabel lain: ia harus tetap bisa mencatat peristiwa tentang entitas apa pun (termasuk yang bentuknya berubah di versi berikutnya) tanpa constraint yang bisa menolak penulisan catatan audit. Catatan audit yang gagal ditulis karena FK lebih buruk daripada catatan audit yang id-nya tidak lagi bisa di-join.

---

## 5. Invariant yang harus selalu benar

Ini daftar yang dipakai untuk menulis test integrasi.

**Uang**
1. `Transaction.netTotal == grossSubtotal − itemDiscountTotal − transactionDiscount`
2. `Σ TransactionItem.lineGross == Transaction.grossSubtotal`
3. `Σ TransactionItem.itemDiscount == Transaction.itemDiscountTotal`
4. **`Σ TransactionItem.allocatedTxDiscount == Transaction.transactionDiscount`** (persis — largest remainder)
5. `TransactionItem.lineNet == lineGross − itemDiscount`
5b. `TransactionItem.lineFinal == lineNet − allocatedTxDiscount`
5c. **`Σ TransactionItem.lineFinal == Transaction.netTotal`** (persis)
6. `Transaction.cogsTotal == Σ (unitCost × qty)`
7. Refund penuh atas seluruh item → `Σ RefundItem.amount == Transaction.netTotal` (persis)
8. Semua kolom uang adalah integer ≥ 0, kecuali `Shift.difference` yang boleh negatif

**Stok**
9. `StockMovement.stockAfter == stockBefore + qtyChange`
10. Untuk setiap produk: `Product.stok == Σ StockMovement.qtyChange` (seluruh sejarah)
11. Setiap perubahan `Product.stok` punya tepat satu baris `StockMovement` yang bersesuaian
12. `Σ RefundItem.qty` per `transactionItemId` == `TransactionItem.refundedQty` ≤ `TransactionItem.qty`
12b. `Σ RefundItem.amount` per `transactionItemId` == `TransactionItem.refundedAmount`
12c. Saat `refundedQty == qty` → `refundedAmount == lineFinal` **persis** (`reporting.md` §3.2)

**Status & relasi**
13. Transaksi `COMPLETED` punya tepat satu `Payment` berstatus `PAID`
14. Transaksi `PENDING` tidak punya `StockMovement` sama sekali
15. Transaksi `VOIDED` punya `StockMovement` reason `SALE` **dan** reason `VOID` yang saling menghabiskan
16. Maksimal satu `Shift` berstatus `OPEN` per `cashierId` (ditegakkan `openKey @unique`)
17. Setiap `Transaction` punya `shiftId` yang valid — tidak ada penjualan di luar shift
18. `Shift` berstatus `CLOSED` tidak pernah berubah lagi
19. Pembayaran berstatus terminal (`PAID`/`EXPIRED`/`CANCELLED`/`FAILED`) tidak pernah berubah lagi

**Waktu**
20. `businessDate` sebuah baris == tanggal WIB dari `createdAt`-nya
21. `Refund.businessDate` == tanggal refund, **bukan** tanggal transaksi asal

---

## 6. Kunci settings

Semua nilai disimpan sebagai `String`, di-parse per key lewat Zod di `lib/settings`.

| Key | Tipe | Default | Catatan |
|---|---|---|---|
| `storeName` | string | `"Toko Saya"` | Header struk |
| `storeAddress` | string | `""` | |
| `storePhone` | string | `""` | |
| `receiptFooter` | string | `"Terima kasih"` | |
| `receiptWidth` | `"58"\|"80"\|"a4"` | `"80"` | Preset CSS print |
| `timezone` | string | `"Asia/Jakarta"` | Dasar `businessDate` |
| `installDate` | `YYYY-MM-DD` | tanggal seed | Titik awal catch-up |
| `qrisEnabled` | boolean | `false` | |
| `qrisImagePath` | string | `""` | Relatif terhadap `data/uploads/` |
| `discordWebhookUrl` | string | `""` | **Secret** — ter-mask saat dibaca |
| `telegramBotToken` | string | `""` | **Secret** — ter-mask saat dibaca |
| `telegramChatId` | string | `""` | |
| `reportDailyTime` | `HH:mm` | `"21:00"` | Untuk cron; catch-up tetap jaring utama |
| `reportWeeklyDay` | 1–7 | `1` | ISO: 1=Senin |
| `reportMonthlyDay` | 1–28 | `1` | |
| `catchUpMaxPeriods` | int | `60` | Cap backlog |
| `lowStockAlert` | boolean | `true` | Sertakan bagian stok di laporan |
| `expenseCategories` | JSON array | `["Operasional","Listrik","Sewa","Gaji","Lain-lain"]` | |

**Penanganan secret:** `GET /api/settings` mengembalikan secret dalam bentuk ter-mask (`"https://discord.com/api/webhooks/…abcd"`), hanya untuk owner. `PATCH` dengan nilai mask persis = tidak berubah. Secret disimpan di SQLite, jadi ikut masuk file backup — ini ditulis apa adanya di README, bukan diklaim terenkripsi. `GEMINI_API_KEY` **hanya** dari env, tidak pernah dari DB dan tidak pernah dikirim ke client.

---

## 7. Rencana migration

| Migration | Isi |
|---|---|
| `0001_init` | Seluruh 16 tabel di §3 |
| — | PRAGMA **bukan** migration; dijalankan per koneksi saat startup (`architecture.md` §6.1) |

Seluruh schema dibuat dalam satu migration awal karena belum ada data produksi. Setelah toko mulai memakai, setiap perubahan schema jadi migration incremental tersendiri — dan wajib diuji terhadap **salinan backup asli**, bukan cuma DB kosong.

### Seed (`prisma/seed.ts`)
- 1 owner + 2 kasir, `mustChangePin=true`, PIN default dicetak ke console.
- 20 produk realistis Indonesia dengan kategori campuran (minuman, makanan ringan, sembako, rokok, kebutuhan rumah), `hargaBeli` < `hargaJual`, `stokMinimum` terisi.
- Setiap produk mendapat `StockMovement` reason `INITIAL` supaya invariant #10 (`stok == Σ qtyChange`) berlaku sejak awal.
- Semua baris `Setting` dengan nilai default.
- `installDate` = tanggal seed.
- **Idempoten** — `prisma db seed` dua kali tidak membuat duplikat (upsert by `sku` / `key` / nama user).

---

## 8. Pola akses data

### 8.1 Yang hanya boleh lewat helper
| Operasi | Helper | Alasan |
|---|---|---|
| Ubah `Product.stok` | `applyStockMovement(tx, …)` | Menjamin jejak `stock_movements` + atomic SQL |
| Ambil nomor transaksi/refund | `nextNumber(tx, scope, date)` | Menjamin sequence aman dari race |
| Transisi status pembayaran | `transitionPayment(tx, …)` | Menegakkan state machine + guarded update |
| Baca/tulis setting | `getSetting(key)` / `setSetting(key, value, actor)` | Parse Zod + audit `SETTING_CHANGE` |
| Hitung `businessDate` | `toBusinessDate(date, tz)` | Satu definisi WIB untuk seluruh sistem |
| Catat refund item | `applyRefundItem(tx, …)` | Menegakkan rumus teleskopik + memperbarui `refundedQty`/`refundedAmount` |
| Catat barang masuk | `applyPurchase(tx, …)` | Stok naik via `applyStockMovement` reason `PURCHASE` + audit `COST_CHANGE` bila `hargaBeli` berubah |

**`lineFinal` disimpan, bukan diturunkan.** Alasannya sama dengan `allocatedTxDiscount`: ia adalah angka yang menjadi dasar uang keluar saat refund, dan angka seperti itu tidak boleh punya dua sumber. Kalau diturunkan ulang di tiga tempat (refund, laporan, struk), cukup satu tempat memakai rumus yang salah untuk membuat nominal refund berbeda dari yang tercetak di struk pelanggan. Konsistensinya dijaga invariant #5b dan #5c, yang diuji di integration test.

### 8.2 Query yang butuh raw SQL
1. **Pengurangan/penambahan stok atomic** — `UPDATE … SET stok = stok + ? … RETURNING stok` (`$queryRaw`).
2. **`VACUUM INTO`** untuk backup (`$executeRawUnsafe`, path absolut).
3. **PRAGMA** saat startup.

Selain tiga ini, semua akses lewat Prisma client yang bertipe.

### 8.3 Query laporan
Layer DB **hanya mengambil baris mentah** untuk rentang `businessDate` (transaksi + item + pembayaran + refund + pengeluaran + shift). **Seluruh matematika dilakukan fungsi murni** `aggregateSales(rows, opts)` di `lib/report`, yang bisa diuji tanpa database.

Konsekuensi yang disengaja: **tidak ada satu pun angka laporan yang disimpan di DB.** Semua bisa dihitung ulang untuk tanggal apa pun, kapan pun — termasuk setelah bug perhitungan diperbaiki, tanpa perlu migrasi data.

`SUM()` SQLite mengembalikan 64-bit, dan agregat diterima di JS sebagai `number` (aman sampai 2^53) — lihat `architecture.md` §4.

---

## 9. Retensi data

| Tabel | Retensi |
|---|---|
| `transactions`, `transaction_items`, `payments`, `refunds`, `refund_items` | **Permanen** — catatan penjualan |
| `shifts`, `expenses` | **Permanen** |
| `stock_movements` | **Permanen** — invariant #10 bergantung pada riwayat penuh |
| `audit_logs` | **Permanen** (append-only) |
| `sessions` | Dipangkas saat startup: hapus yang `expiresAt < now` |
| `report_deliveries` | Permanen (jumlahnya kecil; jadi dasar catch-up) |
| `ai_call_logs` | Permanen (jumlahnya sangat kecil) |
| `ai_insights` | Permanen, append-only (maksimal ~1 baris/hari) |
| `daily_counters` | Permanen (satu baris per hari per scope) |
| `startup_locks` | Sementara, dibersihkan otomatis |

Tidak ada purge otomatis untuk data penjualan. Toko kecil tidak akan membuat SQLite kewalahan — 200 transaksi/hari × 5 tahun ≈ 365 ribu baris, jauh di bawah batas praktis SQLite. Menghapus data penjualan otomatis akan menghancurkan kemampuan menghitung ulang laporan, yang justru salah satu jaminan inti sistem ini.
