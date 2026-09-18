# QRIS — Provider Pembayaran

> Status: **Draft untuk review.** Pendamping `architecture.md`.

---

## 1. Keadaan v1, dinyatakan apa adanya

**v1 tidak tersambung ke payment gateway mana pun.** Tidak ada Midtrans, tidak ada Xendit, tidak ada webhook, tidak ada pengecekan status otomatis.

Yang ada adalah `StaticQrisProvider`: menampilkan gambar QR statis milik toko, dan kasir menekan tombol konfirmasi setelah melihat notifikasi masuk di HP-nya. Itu saja, dan itu memang cukup untuk toko kecil yang sudah punya QRIS statis dari banknya.

Tujuan seluruh desain di dokumen ini adalah: **saat provider asli ditambahkan nanti, kode transaksi tidak berubah sama sekali.**

---

## 2. Interface

```ts
export interface PaymentProvider {
  readonly name: string

  /** Apakah provider siap dipakai (credential/konfigurasi lengkap). */
  isConfigured(): boolean

  /** Dipanggil saat transaksi dibuat. Tidak boleh menandai PAID. */
  createPayment(
    amount: number,
    transactionId: string,
  ): Promise<{ qrPayload?: string; externalId?: string }>

  /** Status terkini menurut provider. */
  checkStatus(externalId: string): Promise<PaymentStatus>
}

export type PaymentStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED'
```

`amount` adalah **integer rupiah penuh**, sama seperti di seluruh sistem.

`qrPayload` opsional karena maknanya berbeda antar provider: untuk provider dinamis ia berisi string QRIS yang dirender menjadi gambar; untuk `StaticQrisProvider` ia tidak dipakai sama sekali (gambar QR statis diambil dari setting toko).

---

## 3. `StaticQrisProvider` — alur v1

```
┌─ Kasir menekan "QRIS" di layar pembayaran
│
├─ POST /api/transactions  { method: 'QRIS_STATIC', ... }
│     └─ satu DB transaction:
│          Transaction  status = PENDING
│          TransactionItem[]   (snapshot harga & HPP)
│          Payment      status = PENDING, providerName = 'qris-static'
│        ── STOK BELUM BERKURANG ──
│
├─ Layar menampilkan: gambar QR statis toko (setting `qrisImagePath`)
│                     + nominal yang harus dibayar, huruf besar
│                     + tombol [Pembayaran diterima]  [Batalkan]
│
├─ Pelanggan scan & bayar → kasir melihat notifikasi masuk di HP-nya sendiri
│
├─ Kasir menekan [Pembayaran diterima]
│     └─ POST /api/payments/:id/confirm
│          └─ settleTransaction():
│               Payment PENDING → PAID   (guarded update)
│               stok berkurang + stock_movements (reason SALE)
│               Transaction → COMPLETED
│               AuditLog PAYMENT_CONFIRM  ← siapa yang mengonfirmasi, tercatat
│
└─ Struk siap dicetak, keranjang kembali kosong
```

### 3.1 Kenapa stok baru berkurang saat PAID
Transaksi QRIS yang batal (pelanggan berubah pikiran, HP-nya bermasalah) tidak boleh meninggalkan stok yang berkurang. Dengan menunda pengurangan stok sampai `PAID`, transaksi `PENDING` yang ditinggalkan tidak punya efek samping apa pun — cukup `CANCELLED`, tanpa perlu membalik stok.

Konsekuensi yang diterima: ada jeda antara QR ditampilkan dan stok berkurang, sehingga dua kasir bisa sama-sama menampilkan QR untuk barang terakhir. Karena stok minus diizinkan (`architecture.md` §8), keduanya tetap bisa lanjut dan stok menjadi negatif — muncul di bagian "stok perlu diperiksa" pada laporan. Ini pilihan yang benar untuk toko: tidak menahan pembayaran yang sudah masuk hanya karena angka stok.

### 3.2 Larangan keras
Tiga hal ini **tidak boleh** ada di dalam kode, dalam bentuk apa pun:

1. ❌ **Mock yang otomatis sukses setelah beberapa detik.** Tidak ada `setTimeout` yang mengubah status menjadi `PAID`. Tidak ada di dev, tidak ada di test fixture yang bisa bocor ke produksi.
2. ❌ **Menandai `PAID` tanpa aksi konfirmasi eksplisit.** Satu-satunya jalan menuju `PAID` untuk `StaticQrisProvider` adalah request HTTP yang dipicu manusia menekan tombol, dengan session terautentikasi, dan `confirmedByUserId` tercatat.
3. ❌ **Mengklaim "QRIS tersambung"** di UI mana pun. Halaman pengaturan menampilkan keadaan sebenarnya: `QRIS statis aktif (konfirmasi manual kasir)` — bukan "terintegrasi".

`checkStatus()` pada `StaticQrisProvider` mengembalikan status yang **tersimpan di database**, bukan menebak dan bukan memanggil ke mana pun. Ia tidak pernah bisa mengubah `PENDING` menjadi `PAID` dengan sendirinya.

```ts
class StaticQrisProvider implements PaymentProvider {
  readonly name = 'qris-static'

  isConfigured() { return Boolean(getSetting('qrisEnabled')) && Boolean(getSetting('qrisImagePath')) }

  async createPayment() {
    // Tidak ada panggilan jaringan. QR statis tidak per-transaksi.
    return {}
  }

  async checkStatus(externalId: string) {
    // Membaca status tersimpan. TIDAK PERNAH memajukan state sendiri.
    return readStoredStatus(externalId)
  }
}
```

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
Hanya mengizinkan transisi dari `PENDING`. Diuji untuk seluruh 25 kombinasi state.

**Lapis 2 — guarded update di database**
```ts
const res = await tx.payment.updateMany({
  where: { id, status: 'PENDING' },      // ← gerbangnya di sini
  data:  { status: 'PAID', paidAt: now, confirmedByUserId: actor.id },
})
if (res.count !== 1) throw new ConflictError('Pembayaran sudah diproses')
```

Lapis 2 wajib ada karena lapis 1 tidak bisa mencegah **race**: dua kasir di dua device menekan "Pembayaran diterima" pada transaksi yang sama dalam selang milidetik, keduanya membaca status `PENDING`, keduanya lolos `canTransition`. Guarded update membuat hanya satu yang berhasil (`count === 1`); yang kedua mendapat `count === 0` dan ditolak dengan pesan jelas. **Stok tidak berkurang dua kali.**

Ini diuji secara eksplisit sebagai "test penolakan double-confirm".

### 4.1 Pemetaan state
| Kejadian | Transisi |
|---|---|
| Kasir menekan "Pembayaran diterima" | `PENDING → PAID` |
| Kasir menekan "Batalkan" | `PENDING → CANCELLED` |
| **Shift ditutup, pembayaran masih `PENDING`** | `PENDING → CANCELLED` otomatis, tercatat di audit log |
| Provider dinamis melaporkan kedaluwarsa | `PENDING → EXPIRED` |
| Provider dinamis melaporkan gagal | `PENDING → FAILED` |
| Void transaksi (tunai/QRIS yang sudah PAID) | Pembayaran → `CANCELLED` **bersama** transaksi → `VOIDED`, dalam satu DB transaction |

Void adalah satu-satunya jalan keluar dari `PAID`, dan ia tidak melanggar aturan terminal karena void tidak "membatalkan pembayaran" secara diam-diam — ia membatalkan seluruh transaksi sebagai satu peristiwa tercatat dengan otorisasi PIN owner, jejak audit, dan pembalikan stok.

### 4.2 Transaksi terlantar

Transaksi QRIS yang ditinggalkan akan menggantung `PENDING`. **Saat shift ditutup, semua transaksi `PENDING` milik shift itu otomatis `CANCELLED`, dan penutupan shift tidak pernah diblokir karenanya** (`architecture.md` §9.1).

Ini aman tanpa efek samping justru karena keputusan di §3.1: transaksi `PENDING` belum pernah menyentuh stok dan pembayarannya belum pernah `PAID`, jadi tidak ada stok yang perlu dibalik dan tidak ada pengaruh ke `expectedCash`. Kalau stok dikurangi lebih awal, setiap transaksi terlantar akan meninggalkan stok hilang yang harus dibereskan manual.

### 4.3 Void atas QRIS yang sudah `PAID` — uangnya tidak bisa ditarik

Sistem ini tidak punya jalur ke rekening toko. Void hanya membereskan pencatatan dan stok di sisi kita; **dana QRIS yang sudah masuk tetap di rekening.**

Karena itu dialog void untuk pembayaran non-tunai yang sudah `PAID` menampilkan peringatan eksplisit bahwa pengembalian uang harus dilakukan manual oleh pemilik, dan audit log menyimpan flag `manualRefundRequired: true` supaya kewajiban itu bisa ditelusuri di dashboard — bukan bergantung pada ingatan orang yang menekan tombol. Rinciannya di `architecture.md` §9.2.

---

## 5. Menambahkan provider dinamis nanti

Langkah-langkah untuk Midtrans / Xendit / provider QRIS dinamis lain. **Tidak ada satu pun yang menyentuh kode transaksi, keranjang, laporan, atau struk.**

### Langkah 1 — Implementasikan interface
`src/lib/payment/providers/midtrans.ts`:
```ts
export class MidtransProvider implements PaymentProvider {
  readonly name = 'midtrans'

  isConfigured() { return Boolean(process.env.MIDTRANS_SERVER_KEY) }

  async createPayment(amount: number, transactionId: string) {
    const res = await callMidtransCharge({ amount, orderId: transactionId })
    return { qrPayload: res.qr_string, externalId: res.transaction_id }
  }

  async checkStatus(externalId: string): Promise<PaymentStatus> {
    const res = await callMidtransStatus(externalId)
    return mapMidtransStatus(res.transaction_status)   // → PENDING|PAID|EXPIRED|FAILED
  }
}
```
Credential **hanya** dari env, tidak dari DB.

### Langkah 2 — Daftarkan di registry
`src/lib/payment/registry.ts`:
```ts
const providers: Record<string, PaymentProvider> = {
  'cash':        cashProvider,
  'qris-static': staticQrisProvider,
  'midtrans':    midtransProvider,      // ← satu baris
}
```
Metode pembayaran baru ditambahkan ke Zod enum `PaymentMethod` dan ke tombol di layar pembayaran.

### Langkah 3 — Hubungkan sinyal masuk ke `settleTransaction`

Dua jalur, **keduanya memanggil `settleTransaction` yang sama persis:**

**a) Webhook** — `POST /api/payments/webhook/midtrans`
- **Verifikasi signature sebelum apa pun.** Payload webhook adalah data dari internet, bukan perintah: signature tidak valid → `401`, tidak ada perubahan state, dicatat.
- Cari `Payment` berdasarkan `externalId`. Tidak ditemukan → `404`, jangan membuat apa pun.
- Petakan status provider → state kita, lalu jalankan transisi bergerbang yang sama.
- **Idempoten wajib** — gateway mengirim webhook yang sama berulang kali. Guarded update sudah menanganinya: kiriman kedua mendapat `count === 0` dan dijawab `200 OK` tanpa efek samping. Menjawab error pada kiriman ulang akan membuat gateway terus mencoba lagi.
- Webhook butuh alamat yang bisa dijangkau dari internet, sedangkan server ini ada di LAN toko. Artinya webhook **memerlukan** tunnel/reverse proxy — dan itu keputusan operasional tersendiri, bukan sesuatu yang bisa diaktifkan diam-diam. Karena itu jalur polling di bawah tetap disediakan.

**b) Polling** — `GET /api/payments/:id/status`
- Layar pembayaran melakukan polling tiap ~3 detik selama QR ditampilkan, dengan **timeout** (misal 5 menit) lalu `PENDING → EXPIRED`.
- Handler memanggil `provider.checkStatus(externalId)`; kalau `PAID`, jalankan `settleTransaction`.
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

Satu fungsi, `settleTransaction(tx, transactionId, actor)`, adalah **satu-satunya** jalan sebuah transaksi menjadi `COMPLETED` dan stok berkurang. Tunai, QRIS statis, webhook Midtrans, polling, dan konfirmasi manual darurat — semuanya bermuara ke fungsi itu.

Akibatnya, semua yang benar sekarang tetap benar setelah provider asli masuk:
- Checkout tetap atomic dalam satu DB transaction.
- Stok tetap berkurang tepat satu kali, dengan `stock_movements` sebagai jejak.
- `PAID` ganda tetap mustahil, dijaga di level database.
- Rekonsiliasi kas dan laporan tidak perlu tahu provider mana yang dipakai.

Kalau setiap metode pembayaran punya jalur settle-nya sendiri, setiap provider baru akan membawa salinan bug-nya sendiri. Itulah yang dihindari desain ini, dan itulah alasan `PaymentProvider` sengaja **tidak** punya wewenang mengubah stok, transaksi, atau status — provider hanya melaporkan apa yang terjadi di dunia luar. Keputusan menulis ke database tetap milik `settleTransaction`.
