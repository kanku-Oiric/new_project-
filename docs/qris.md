# QRIS — Provider Pembayaran

> Status: **Terpasang di Fase 5.** Dokumen ini menggambarkan kode yang benar-benar ada, bukan rencana. Bagian §5 (provider dinamis) tetap berupa panduan untuk nanti dan ditandai apa adanya. Pendamping `architecture.md`.

---

## 1. Keadaan v1, dinyatakan apa adanya

**v1 tidak tersambung ke payment gateway mana pun.** Tidak ada Midtrans, tidak ada Xendit, tidak ada webhook, tidak ada pengecekan status otomatis.

Yang ada adalah `StaticQrisProvider`: menampilkan gambar QR statis milik toko, dan kasir menekan tombol konfirmasi setelah melihat notifikasi masuk di HP-nya. Itu saja, dan itu memang cukup untuk toko kecil yang sudah punya QRIS statis dari banknya.

Tujuan seluruh desain di dokumen ini adalah: **saat provider asli ditambahkan nanti, kode transaksi tidak berubah sama sekali.**

---

## 2. Interface

`src/lib/payment/provider.ts`:

```ts
export interface PaymentProvider {
  readonly name: string
  readonly method: PaymentMethod

  /**
   * true  = selesai pada request yang membuat transaksinya (tunai)
   * false = berhenti di PENDING, butuh request konfirmasi tersendiri (QRIS)
   */
  readonly settlesOnCreate: boolean

  isConfigured(): Promise<boolean>
  describe(): Promise<ProviderReadiness>

  /** Dipanggil saat transaksi dibuat. Tidak boleh menandai PAID. */
  createPayment(input: { amount: number; transactionId: string }): Promise<{
    qrPayload?: string
    externalId?: string
  }>

  /** Status menurut provider. Tidak pernah memajukan state sendiri. */
  checkStatus(ref: { paymentId: string; externalId: string | null }): Promise<PaymentStatus | null>
}
```

`amount` adalah **integer rupiah penuh**, sama seperti di seluruh sistem.

Tiga hal di interface ini berbeda dari rancangan awal, dan alasannya masing-masing:

| Perbedaan | Alasan |
|---|---|
| `isConfigured()` mengembalikan `Promise` | Kesiapan QRIS statis tersimpan di tabel settings, jadi membacanya adalah query. Versi sinkron hanya mungkin kalau setting di-cache, dan cache yang basi berarti tombol QRIS mati padahal pemilik baru menyalakannya. |
| `checkStatus` menerima `{ paymentId, externalId }`, bukan `externalId` saja | QRIS statis tidak punya `externalId` — QR-nya milik toko, bukan dibuat per transaksi. Tanpa `paymentId`, provider statis tidak punya kunci apa pun untuk dicari. |
| Ada `describe()` yang mengembalikan `ProviderReadiness` | Kalimat status (`"QRIS statis aktif (konfirmasi manual kasir)"`) tinggal di provider, bukan di komponen. Dengan begitu tidak ada halaman yang bisa menulis klaim lebih berani daripada keadaan sebenarnya — larangan ketiga di §3.2 jadi ditegakkan oleh struktur, bukan oleh disiplin. |

`qrPayload` opsional karena maknanya berbeda antar provider: untuk provider dinamis ia berisi string QRIS yang dirender menjadi gambar; untuk `StaticQrisProvider` ia tidak dipakai sama sekali (gambar QR statis diambil dari setting toko).

### 2.1 Dependensi provider ditulis eksplisit

```ts
export interface ProviderDeps {
  readSetting: <K extends SettingKey>(key: K) => Promise<SettingValue<K>>
  readStoredStatus: (paymentId: string) => Promise<PaymentStatus | null>
}
```

Provider dibuat lewat factory yang menerima `ProviderDeps`, bukan mengimpor Prisma langsung. Dua akibatnya nyata: seluruh keadaan provider bisa diuji tanpa database (`src/lib/payment/providers.test.ts` berjalan dalam milidetik), dan `db` bisa diarahkan ke transaction client saat dipakai di dalam `$transaction`.

---

## 3. `StaticQrisProvider` — alur v1

```
┌─ Kasir menekan "Bayar dengan QRIS" di layar pembayaran
│     └─ tombolnya mati kalau QRIS belum dikonfigurasi, DENGAN keterangan
│        alasannya — bukan sekadar disabled
│
├─ POST /api/transactions  { method: 'QRIS_STATIC', ... }
│     └─ provider belum siap → 400, tidak ada apa pun yang tertulis
│     └─ satu DB transaction:
│          Transaction  status = PENDING
│          TransactionItem[]   (snapshot harga & HPP)
│          Payment      status = PENDING, providerName = 'qris-static'
│        ── STOK BELUM BERKURANG ──
│
├─ Layar menampilkan: gambar QR statis toko (setting `qrisImagePath`)
│                     + nominal yang harus dibayar, huruf besar
│                     + kalimat "Sistem tidak memeriksa pembayaran secara otomatis"
│                     + tombol [Pembayaran diterima]  [Batalkan]
│
├─ Pelanggan scan & bayar → kasir melihat notifikasi masuk di HP-nya sendiri
│
├─ Kasir menekan [Pembayaran diterima]
│     └─ POST /api/payments/:id/confirm      (tanpa body)
│          └─ requireSession()               ← tidak ada konfirmasi anonim
│          └─ settleTransactionInTx():
│               Payment PENDING → PAID   (lapis 1 + guarded update)
│               stok berkurang + stock_movements (reason SALE)
│               Transaction → COMPLETED
│               AuditLog PAYMENT_CONFIRM  ← siapa yang mengonfirmasi, tercatat
│
└─ Struk siap dicetak, keranjang kembali kosong
```

Kalau kasir menekan [Batalkan]: `POST /api/payments/:id/cancel` → pembayaran `CANCELLED`, transaksi `CANCELLED`, **keranjang di layar dibiarkan utuh** supaya bisa langsung dilanjutkan dengan tunai. Pembatalan tidak butuh PIN pemilik: tidak ada uang yang berpindah dan tidak ada stok yang bergerak. Yang dicatat adalah siapa yang membatalkan.

### 3.1 Kenapa stok baru berkurang saat PAID
Transaksi QRIS yang batal (pelanggan berubah pikiran, HP-nya bermasalah) tidak boleh meninggalkan stok yang berkurang. Dengan menunda pengurangan stok sampai `PAID`, transaksi `PENDING` yang ditinggalkan tidak punya efek samping apa pun — cukup `CANCELLED`, tanpa perlu membalik stok.

Konsekuensi yang diterima: ada jeda antara QR ditampilkan dan stok berkurang, sehingga dua kasir bisa sama-sama menampilkan QR untuk barang terakhir. Karena stok minus diizinkan (`architecture.md` §8), keduanya tetap bisa lanjut dan stok menjadi negatif — muncul di bagian "stok perlu diperiksa" pada laporan. Ini pilihan yang benar untuk toko: tidak menahan pembayaran yang sudah masuk hanya karena angka stok.

### 3.2 Larangan keras, dan bagaimana masing-masing ditegakkan

Tiga hal ini **tidak boleh** ada di dalam kode, dalam bentuk apa pun:

1. ❌ **Mock yang otomatis sukses setelah beberapa detik.** Tidak ada `setTimeout` yang mengubah status menjadi `PAID`. Tidak ada di dev, tidak ada di test fixture yang bisa bocor ke produksi.
2. ❌ **Menandai `PAID` tanpa aksi konfirmasi eksplisit.** Satu-satunya jalan menuju `PAID` untuk `StaticQrisProvider` adalah request HTTP yang dipicu manusia menekan tombol, dengan session terautentikasi, dan `confirmedByUserId` tercatat.
3. ❌ **Mengklaim "QRIS tersambung"** di UI mana pun. Halaman pengaturan menampilkan keadaan sebenarnya: `QRIS statis aktif (konfirmasi manual kasir)` — bukan "terintegrasi".

Ketiganya punya test, karena larangan tanpa test hanyalah niat baik:

| Larangan | Yang menegakkannya |
|---|---|
| 1 — tanpa timer | `src/lib/payment/no-auto-success.test.ts` memindai kode sumber `src/lib/payment`, `src/lib/checkout`, `src/app/api/payments`, layar kasir, dan layar QRIS; satu `setTimeout` di sana membuat test gagal dan menyebut nama berkasnya. Ditambah `tests/e2e-qris.test.ts` langkah 10: membuat transaksi, **tidak melakukan apa pun selama 3 detik**, lalu memastikan statusnya masih `PENDING`. |
| 2 — PAID butuh manusia | `tests/e2e-qris.test.ts` langkah 11: konfirmasi tanpa cookie → `401`, status tetap `PENDING`. Langkah 12: dua konfirmasi bersamaan → satu `200`, satu `409`, `confirmedByUserId` terisi. `tests/qris.test.ts` memastikan `paidAt` dan `confirmedByUserId` tidak pernah null setelah lunas. |
| 3 — tanpa klaim palsu | `src/lib/payment/providers.test.ts` memeriksa bahwa label dan hint provider **tidak pernah** memuat kata "terintegrasi", "tersambung", atau "otomatis", pada keadaan siap maupun belum. |

Satu test lagi menjaga bentuk sistemnya: **hanya satu berkas di seluruh `src/` yang boleh menulis `paidAt`**, yaitu `src/lib/checkout/index.ts`. Jalur settle kedua — sekecil apa pun niatnya — akan menggagalkan test itu.

`checkStatus()` pada `StaticQrisProvider` mengembalikan status yang **tersimpan di database**, bukan menebak dan bukan memanggil ke mana pun. Ia tidak pernah bisa mengubah `PENDING` menjadi `PAID` dengan sendirinya:

```ts
async checkStatus(ref) {
  // Membaca status TERSIMPAN. Secara konstruksi tidak punya kemampuan
  // memajukan PENDING menjadi PAID — fungsi ini tidak menulis apa pun.
  return deps.readStoredStatus(ref.paymentId)
}
```

### 3.3 Dua syarat kesiapan, dan kenapa keduanya wajib

`isConfigured()` benar hanya kalau **`qrisEnabled` nyala DAN `qrisImagePath` terisi**. Menyalakan QRIS tanpa gambar akan membuat kasir menekan tombol lalu menghadap kotak kosong sementara pelanggan menunggu — jadi `PATCH /api/settings` menolak `qrisEnabled: 'true'` selama gambarnya belum ada, dan halaman pengaturan mematikan tombol "Aktifkan QRIS" dengan keterangan alasannya.

Urutan yang benar: unggah gambar → aktifkan. Ditegakkan server, bukan sekadar disarankan UI.

---

## 4. State machine — sama untuk semua provider

```
                  ┌──────────► PAID       (terminal)
                  │
   PENDING ───────┼──────────► EXPIRED    (terminal)
                  │
                  ├──────────► CANCELLED  (terminal)
                  │
                  └──────────► FAILED     (terminal)

   Tidak ada transisi keluar dari state terminal. Tidak ada pengecualian.
```

Ditegakkan **dua lapis**:

**Lapis 1 — fungsi murni**
```ts
canTransition(from: PaymentState, to: PaymentState): boolean
```
Hanya mengizinkan transisi dari `PENDING`. Diuji untuk seluruh 25 kombinasi state: tepat 4 yang sah.

Lapis ini bukan cuma pengiyaan. Di `settleTransactionInTx`, `canTransition` yang **memilih** baris pembayaran mana yang boleh dilunaskan:

```ts
const pending = transaction.payments.find((p) =>
  canTransition(p.status as PaymentStatus, 'PAID'),
)
```

Status yang dinilai adalah status **tersimpan di database**, bukan yang diasumsikan pemanggil. Karena itu konfirmasi kedua ditolak dengan pesan yang menyebut keadaan sebenarnya ("Pembayaran ini sudah dikonfirmasi. Tidak diproses dua kali."), bukan pesan gagal tanpa keterangan.

**Lapis 2 — guarded update di database**
```ts
const updated = await tx.payment.updateMany({
  where: { id: pending.id, status: 'PENDING' },   // ← gerbangnya di sini
  data: { status: 'PAID', paidAt: now, confirmedByUserId: actor.userId },
})
if (updated.count !== 1) throw new ConflictError('Pembayaran sudah diproses di perangkat lain')
```

Lapis 2 wajib ada karena lapis 1 tidak bisa mencegah **race**: dua kasir di dua device menekan "Pembayaran diterima" pada transaksi yang sama dalam selang milidetik, keduanya membaca status `PENDING`, keduanya lolos `canTransition`. Guarded update membuat hanya satu yang berhasil (`count === 1`); yang kedua mendapat `count === 0` dan ditolak dengan pesan jelas. **Stok tidak berkurang dua kali.**

Diuji di tiga tempat, sengaja berlapis:
- `tests/qris.test.ts` — dua konfirmasi bersamaan dari **dua koneksi Prisma terpisah**: tepat satu berhasil, stok berkurang sekali, tepat satu `stock_movements`, tepat satu audit `PAYMENT_CONFIRM`.
- `tests/e2e-qris.test.ts` — dua `POST /api/payments/:id/confirm` bersamaan lewat HTTP: `[200, 409]`.
- `tests/qris.test.ts` — `updateMany` dengan syarat `status: 'PENDING'` atas baris yang sudah `PAID` menghasilkan `count === 0`. Ini menguji mekanismenya, bukan kode kita, dan memang itu maksudnya: seluruh jaminan "tidak pernah lunas dua kali" bertumpu pada perilaku tersebut.

### 4.1 Pemetaan state
| Kejadian | Transisi |
|---|---|
| Kasir menekan "Pembayaran diterima" | `PENDING → PAID` |
| Kasir menekan "Batalkan" | `PENDING → CANCELLED` |
| **Shift ditutup, pembayaran masih `PENDING`** | `PENDING → CANCELLED` otomatis, tercatat di audit log |
| Provider dinamis melaporkan kedaluwarsa | `PENDING → EXPIRED` (belum ada provider yang bisa) |
| Provider dinamis melaporkan gagal | `PENDING → FAILED` (belum ada provider yang bisa) |
| Void transaksi (tunai/QRIS yang sudah PAID) | Pembayaran → `CANCELLED` **bersama** transaksi → `VOIDED`, dalam satu DB transaction |

`EXPIRED` dan `FAILED` ada di state machine dan diuji, tetapi **belum ada satu pun jalur di v1 yang menghasilkannya** — keduanya menunggu provider dinamis. Ditulis di sini supaya tidak ada yang mengira sistem ini punya kedaluwarsa otomatis: transaksi QRIS yang ditinggalkan tetap `PENDING` sampai dibatalkan kasir atau sampai shift ditutup.

Void adalah satu-satunya jalan keluar dari `PAID`, dan ia tidak melanggar aturan terminal karena void tidak "membatalkan pembayaran" secara diam-diam — ia membatalkan seluruh transaksi sebagai satu peristiwa tercatat dengan otorisasi PIN owner, jejak audit, dan pembalikan stok.

### 4.2 Transaksi terlantar

Transaksi QRIS yang ditinggalkan akan menggantung `PENDING`. **Saat shift ditutup, semua transaksi `PENDING` milik shift itu otomatis `CANCELLED`, dan penutupan shift tidak pernah diblokir karenanya** (`architecture.md` §9.1).

Ini aman tanpa efek samping justru karena keputusan di §3.1: transaksi `PENDING` belum pernah menyentuh stok dan pembayarannya belum pernah `PAID`, jadi tidak ada stok yang perlu dibalik dan tidak ada pengaruh ke `expectedCash`. Kalau stok dikurangi lebih awal, setiap transaksi terlantar akan meninggalkan stok hilang yang harus dibereskan manual.

Diuji di `tests/e2e-qris.test.ts` langkah 15: satu transaksi QRIS dibuat lalu ditinggalkan, shift ditutup → `200`, `cancelledPending: 1`, transaksinya `CANCELLED`, `expectedCash` tetap sama dengan kas awal (QRIS tidak masuk laci), dan audit `PENDING_CANCELLED_ON_SHIFT_CLOSE` tercatat.

### 4.3 Void atas QRIS yang sudah `PAID` — uangnya tidak bisa ditarik

Sistem ini tidak punya jalur ke rekening toko. Void hanya membereskan pencatatan dan stok di sisi kita; **dana QRIS yang sudah masuk tetap di rekening.**

Karena itu dialog void untuk pembayaran non-tunai yang sudah `PAID` menampilkan peringatan eksplisit bahwa pengembalian uang harus dilakukan manual oleh pemilik, dan audit log menyimpan flag `manualRefundRequired: true` supaya kewajiban itu bisa ditelusuri di dashboard — bukan bergantung pada ingatan orang yang menekan tombol. Rinciannya di `architecture.md` §9.2.

---

## 5. Menambahkan provider dinamis nanti

> Bagian ini **belum diimplementasikan**. Isinya panduan, bukan deskripsi kode yang ada.

Langkah-langkah untuk Midtrans / Xendit / provider QRIS dinamis lain. **Tidak ada satu pun yang menyentuh kode transaksi, keranjang, laporan, atau struk.**

### Langkah 1 — Implementasikan interface
`src/lib/payment/providers/midtrans.ts`:
```ts
export function createMidtransProvider(deps: ProviderDeps): PaymentProvider {
  return {
    name: 'midtrans',
    method: 'QRIS_DYNAMIC',
    settlesOnCreate: false,

    async isConfigured() { return Boolean(process.env.MIDTRANS_SERVER_KEY) },
    async describe() { /* label jujur untuk UI */ },

    async createPayment({ amount, transactionId }) {
      const res = await callMidtransCharge({ amount, orderId: transactionId })
      return { qrPayload: res.qr_string, externalId: res.transaction_id }
    },

    async checkStatus({ externalId }) {
      if (!externalId) return null
      const res = await callMidtransStatus(externalId)
      return mapMidtransStatus(res.transaction_status)   // → PENDING|PAID|EXPIRED|FAILED
    },
  }
}
```
Credential **hanya** dari env, tidak dari DB.

### Langkah 2 — Daftarkan di registry
`src/lib/payment/registry.ts`:
```ts
export function providersFor(db: Db = prisma): Record<PaymentMethod, PaymentProvider> {
  const deps = providerDeps(db)
  return {
    CASH:          createCashProvider(deps),
    QRIS_STATIC:   createStaticQrisProvider(deps),
    QRIS_DYNAMIC:  createMidtransProvider(deps),   // ← satu baris
  }
}
```
Tipenya `Record<PaymentMethod, PaymentProvider>` dengan sengaja: menambahkan metode di `enums.ts` tanpa menulis providernya menjadi **error kompilasi**, bukan kegagalan runtime di depan pelanggan. Metode baru lalu ditambahkan ke Zod enum `PaymentMethod` dan ke tombol di layar pembayaran.

### Langkah 3 — Hubungkan sinyal masuk ke `settleTransaction`

Dua jalur, **keduanya memanggil `settleTransactionInTx` yang sama persis:**

**a) Webhook** — `POST /api/payments/webhook/midtrans`
- **Verifikasi signature sebelum apa pun.** Payload webhook adalah data dari internet, bukan perintah: signature tidak valid → `401`, tidak ada perubahan state, dicatat.
- Cari `Payment` berdasarkan `externalId`. Tidak ditemukan → `404`, jangan membuat apa pun.
- Petakan status provider → state kita, lalu jalankan transisi bergerbang yang sama.
- **Idempoten wajib** — gateway mengirim webhook yang sama berulang kali. Guarded update sudah menanganinya: kiriman kedua mendapat `count === 0` dan dijawab `200 OK` tanpa efek samping. Menjawab error pada kiriman ulang akan membuat gateway terus mencoba lagi.
- Webhook butuh alamat yang bisa dijangkau dari internet, sedangkan server ini ada di LAN toko. Artinya webhook **memerlukan** tunnel/reverse proxy — dan itu keputusan operasional tersendiri, bukan sesuatu yang bisa diaktifkan diam-diam. Karena itu jalur polling di bawah tetap disediakan.

**b) Polling** — `GET /api/payments/:id/status`
- Endpoint ini **sudah ada** dan sengaja dibuat hanya-baca. Untuk provider dinamis, di sinilah `provider.checkStatus()` yang mengembalikan `PAID` disambungkan ke `settleTransactionInTx`. Di v1 sambungan itu **tidak ada**, dan itu bukan kelalaian: provider statis mengembalikan status tersimpan, sehingga menyambungkannya hanya akan menciptakan jalur melingkar yang melunaskan berdasarkan datanya sendiri.
- Layar pembayaran melakukan polling tiap ~3 detik selama QR ditampilkan, dengan **timeout** (misal 5 menit) lalu `PENDING → EXPIRED`.
- Polling tidak butuh alamat publik, jadi ini jalur yang realistis untuk server LAN.
- **Polling tidak boleh dilakukan di dalam DB transaction** — panggil provider dulu, baru buka transaction.

### Langkah 4 — Pertahankan jalur manual
Tombol "Pembayaran diterima" **tetap ada** sebagai jalur cadangan, dibatasi PIN owner saat provider dinamis aktif. Kalau internet mati sementara QRIS dinamis sedang dipakai, kasir harus tetap bisa menyelesaikan transaksi yang uangnya sudah masuk. Setiap konfirmasi manual atas provider dinamis dicatat di audit log dengan penanda tersendiri, supaya bisa ditinjau.

### Langkah 5 — Yang harus diuji sebelum dipercaya
- Webhook dengan signature salah → `401`, tidak ada perubahan state.
- Webhook dikirim dua kali → hanya satu kali settle, stok berkurang sekali.
- Webhook datang saat pembayaran sudah `CANCELLED` → ditolak, tidak menghidupkan transaksi mati.
- Polling saat internet mati → tidak crash, tidak menggantung UI, tetap `PENDING`.
- `checkStatus` melempar error → transaksi tetap `PENDING`, kasir masih bisa membatalkan.
- Transisi `PAID → PAID` → ditolak di kedua lapis.

---

## 6. Kenapa batas ini ditempatkan di sini

Satu fungsi, `settleTransactionInTx(tx, transactionId, actor)`, adalah **satu-satunya** jalan sebuah transaksi menjadi `COMPLETED` dan stok berkurang. Tunai, QRIS statis, webhook Midtrans, polling, dan konfirmasi manual darurat — semuanya bermuara ke fungsi itu.

Akibatnya, semua yang benar sekarang tetap benar setelah provider asli masuk:
- Checkout tetap atomic dalam satu DB transaction.
- Stok tetap berkurang tepat satu kali, dengan `stock_movements` sebagai jejak.
- `PAID` ganda tetap mustahil, dijaga di level database.
- Rekonsiliasi kas dan laporan tidak perlu tahu provider mana yang dipakai.

Kalau setiap metode pembayaran punya jalur settle-nya sendiri, setiap provider baru akan membawa salinan bug-nya sendiri. Itulah yang dihindari desain ini, dan itulah alasan `PaymentProvider` sengaja **tidak** punya wewenang mengubah stok, transaksi, atau status — provider hanya melaporkan apa yang terjadi di dunia luar. Keputusan menulis ke database tetap milik `settleTransactionInTx`.

---

## 7. Apa yang benar-benar ada di kode (Fase 5)

**Modul**
| Berkas | Isi |
|---|---|
| `src/lib/payment/index.ts` | `canTransition`, `assertTransition`, `settlesImmediately`, hitung kembalian. Murni, tanpa DB, dipakai juga di browser |
| `src/lib/payment/provider.ts` | Interface `PaymentProvider`, `ProviderReadiness`, `ProviderDeps` |
| `src/lib/payment/providers/cash.ts` | `createCashProvider` |
| `src/lib/payment/providers/qris-static.ts` | `createStaticQrisProvider` + kalimat status yang dipakai UI |
| `src/lib/payment/registry.ts` | `providersFor`, `providerForMethod`, `providerByName`, `listProviders` |
| `src/lib/payment/service.ts` | `confirmPayment`, `cancelPayment`, `readPaymentStatus` (+ varian `*InTx`) |
| `src/lib/uploads.ts` | Sniffing tipe gambar dari magic bytes, penjagaan nama berkas |

**Endpoint**
| Route | Akses | Catatan |
|---|---|---|
| `POST /api/payments/:id/confirm` | session apa pun | Tanpa body. Satu-satunya jalan menuju `PAID` |
| `POST /api/payments/:id/cancel` | session apa pun | `{ reason? }`, hanya dari `PENDING` |
| `GET /api/payments/:id/status` | session apa pun | Hanya membaca, tidak pernah melunaskan |
| `PATCH /api/settings` | owner + PIN owner | Validasi per key, audit `SETTING_CHANGE`, secret ter-mask |
| `POST /api/settings/qris-image` | owner + PIN owner | Multipart; tipe dari magic bytes; yang disimpan hanya nama berkas |
| `GET /api/uploads/[...path]` | session apa pun | Satu segmen, hanya tipe gambar, anti path traversal |

**Layar**
- `/kasir` — tombol QRIS aktif hanya kalau providernya siap; kalau tidak, tombolnya mati **dengan keterangan alasan dan jalan keluarnya**.
- Layar tunggu QRIS — gambar QR, nominal besar, kalimat "Sistem tidak memeriksa pembayaran secara otomatis. Status hanya berubah karena kamu menekan tombol, dan namamu tercatat pada transaksi ini.", tombol [Batalkan] dan [Pembayaran diterima], plus "Periksa status tersimpan" yang murni membaca.
- `/pengaturan` — daftar metode pembayaran dengan label dari providernya sendiri, unggah gambar QR, dan tombol nyala/mati. Kalimat di halaman ini: **"QRIS statis aktif (konfirmasi manual kasir)"**, dan di bawahnya "Tidak ada payment gateway yang tersambung."

**Kenapa gambar QR tidak ditaruh di `public/`**
`public/` disajikan tanpa autentikasi dan isinya ikut ke dalam hasil build. Gambar QR toko bukan rahasia besar, tetapi tidak ada alasan menyiarkannya ke siapa pun yang bisa menjangkau alamat server, dan berkas yang ikut build berarti backup database saja tidak cukup untuk memulihkannya. Berkasnya tinggal di `data/uploads/` (bisa dialihkan lewat `UPLOADS_DIR`) dan dilayani route yang memeriksa session.

**Yang belum ada, dan diakui**
- Provider QRIS dinamis (Midtrans/Xendit) — §5 adalah panduannya, bukan kodenya.
- `EXPIRED` dan `FAILED` tidak pernah dihasilkan v1 (§4.1).
- Tidak ada kedaluwarsa otomatis untuk QR yang ditampilkan; yang membereskan transaksi terlantar adalah penutupan shift.
- Gambar QR lama tidak dihapus saat diunggah yang baru — sengaja, supaya kekeliruan unggah masih bisa dipulihkan dari folder.
