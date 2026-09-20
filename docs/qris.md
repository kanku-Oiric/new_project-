# QRIS — Provider Pembayaran

> Status: **Terpasang di Fase 5, state machine void diperketat setelah audit integritas, lalu disederhanakan menjadi alur satu langkah saat toko memakai QRIS soundbox.** Dokumen ini menggambarkan kode yang benar-benar ada, bukan rencana. Bagian §5 (provider dinamis) tetap berupa panduan untuk nanti dan ditandai apa adanya. Pendamping `architecture.md`.

---

## 1. Keadaan v1, dinyatakan apa adanya

**v1 tidak tersambung ke payment gateway mana pun.** Tidak ada Midtrans, tidak ada Xendit, tidak ada webhook, tidak ada pengecekan status otomatis.

Yang ada adalah `StaticQrisProvider`, dan sejak toko memakai **QRIS soundbox** bentuknya jadi jauh lebih sederhana: QR tertempel permanen di meja, kotaknya berbunyi saat pembayaran masuk, dan kasir menekan tombol QRIS **setelah** mendengar bunyinya.

Yang berubah bukan kodenya lebih dulu, melainkan tokonya:

```
dulu   kasir tekan QRIS → layar menampilkan gambar QR → pelanggan scan →
       kasir dengar notifikasi di HP → kasir tekan "Pembayaran diterima"

kini   pelanggan scan QR di meja → soundbox berbunyi → kasir tekan QRIS
```

Pada saat kasir menekan tombolnya, uangnya **sudah** masuk. Langkah kedua yang dulu ada bukan pengaman — ia sumber transaksi terlantar saat kasir lupa menekannya, dan itulah yang selama ini dibersihkan auto-cancel saat tutup shift.

Yang hilang bersama alur itu: modal QR di layar kasir, setting `qrisImagePath`, dan route unggah gambarnya. Yang **tidak** hilang: `PaymentProvider`, state machine, `canTransition`, guarded update, dan jalur `PENDING → PAID` — semuanya tinggal utuh untuk provider dinamis nanti.

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

## 3. `StaticQrisProvider` — alur v1 (satu langkah)

```
┌─ Pelanggan scan QR yang tertempel di meja, lalu membayar
│
├─ Soundbox berbunyi  ← inilah konfirmasinya, dan ia datang dari bank
│
┌─ Kasir menekan "Sudah bayar QRIS" di layar pembayaran
│     └─ tombolnya mati kalau QRIS belum dinyalakan, DENGAN keterangan
│        alasannya — bukan sekadar disabled
│
├─ POST /api/transactions  { method: 'QRIS_STATIC', ... }
│     └─ provider belum siap → 400, tidak ada apa pun yang tertulis
│     └─ satu DB transaction, sama persis seperti tunai:
│          Transaction  status = PENDING
│          TransactionItem[]   (snapshot harga & HPP)
│          Payment      status = PENDING, providerName = 'qris-static'
│          settleTransactionInTx():
│               Payment PENDING → PAID   (lapis 1 + guarded update)
│               stok berkurang + stock_movements (reason SALE)
│               saldo provider bergerak, kalau ada baris jasa (§21.3 architecture)
│               Transaction → COMPLETED
│               AuditLog PAYMENT_CONFIRM  ← siapa yang menekan, tercatat
│
└─ Struk siap dicetak, keranjang kembali kosong
```

Satu langkah **tidak** berarti satu penjaga lebih sedikit. Yang ditempuh persis jalur tunai: `canTransition` memilih baris yang boleh dilunaskan, guarded update di database yang memutuskan pemenang saat dua request bersamaan, dan kunci sekali-pakai tetap berlaku.

### 3.1 Kenapa stok berkurang bersamaan dengan PAID

Dulu stok sengaja ditunda sampai `PAID`, supaya transaksi `PENDING` yang ditinggalkan pelanggan tidak meninggalkan stok yang berkurang. Penundaan itu tidak lagi diperlukan: tidak ada jeda antara "QR ditampilkan" dan "kasir mengonfirmasi", karena QR-nya tidak pernah ditampilkan dan kasir menekan tombolnya setelah uangnya masuk.

Yang tersisa dari alasan lama tetap berlaku untuk provider dinamis nanti, dan kodenya tidak dihapus: `createTransactionInTx` tetap tidak menyentuh stok, dan `settleTransactionInTx` tetap satu-satunya yang menguranginya.

### 3.2 Larangan keras, dan bagaimana masing-masing ditegakkan

Tiga hal ini **tidak boleh** ada di dalam kode, dalam bentuk apa pun:

1. ❌ **Mock yang otomatis sukses setelah beberapa detik.** Tidak ada `setTimeout` yang mengubah status menjadi `PAID`. Tidak ada di dev, tidak ada di test fixture yang bisa bocor ke produksi.
2. ❌ **Menandai `PAID` tanpa aksi manusia.** Satu-satunya jalan menuju `PAID` untuk `StaticQrisProvider` tetap request HTTP yang dipicu manusia menekan tombol, dengan session terautentikasi, dan `confirmedByUserId` tercatat. Yang berubah adalah JUMLAH tombolnya — dari dua menjadi satu — bukan siapa yang menekannya.
3. ❌ **Mengklaim "QRIS tersambung"** di UI mana pun. Halaman pengaturan menampilkan keadaan sebenarnya: `QRIS soundbox aktif (kasir menekan setelah bunyi)` — bukan "terintegrasi", dan bukan pula "otomatis". Bunyinya datang dari kotak milik bank; sistem ini tidak mendengarnya dan tidak pernah tahu sendiri uangnya masuk.

Ketiganya punya test, karena larangan tanpa test hanyalah niat baik:

| Larangan | Yang menegakkannya |
|---|---|
| 1 — tanpa timer | `src/lib/payment/no-auto-success.test.ts` memindai kode sumber `src/lib/payment`, `src/lib/checkout`, `src/app/api/payments`, dan layar kasir; satu `setTimeout` di sana membuat test gagal dan menyebut nama berkasnya. Ditambah `tests/qris.test.ts`: membaca status 20 kali berturut-turut tidak pernah memajukan `PENDING` menjadi `PAID`. |
| 2 — PAID butuh manusia | `tests/e2e-qris.test.ts` nomor 7: `confirmedByUserId` terisi id kasir yang login. Nomor 13: konfirmasi tanpa cookie → `401`. Nomor 9: konfirmasi ulang atas yang sudah lunas → `409`, stok tidak berkurang dua kali. Nomor 12: baris `PENDING` (jalur provider dinamis) masih dilunaskan lewat `/confirm` dengan session. |
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

### 3.3 Satu syarat kesiapan

`isConfigured()` benar kalau **`qrisEnabled` nyala**. Titik.

Dulu ada syarat kedua — `qrisImagePath` harus terisi — dan syarat itu benar untuk alurnya: menyalakan QRIS tanpa gambar berarti kasir menekan tombol lalu menghadap kotak kosong sementara pelanggan menunggu. Syarat itu hilang bersama gambarnya. QR soundbox tertempel di meja dan tidak pernah ditampilkan di layar siapa pun, jadi tidak ada berkas yang bisa diunggah maupun diperiksa.

Yang menggantikannya adalah kenyataan fisik: kalau kotaknya belum terpasang, pemiliknya tidak akan menyalakan QRIS.

**Yang ikut dihapus, dan bukan sekadar disembunyikan:**

| Dihapus | Kenapa |
|---|---|
| `src/components/kasir/qris-pending.tsx` | Modal QR + tombol konfirmasi/batal. Tidak pernah dirender lagi |
| `src/app/api/settings/qris-image/route.ts` | Route unggah gambar. Selama ia hidup, ia tetap bisa dipanggil siapa pun di WiFi toko dan tetap menulis berkas ke disk untuk fitur yang sudah tidak ada |
| Setting `qrisImagePath` | Beserta pemeriksaan silang di `PATCH /api/settings` |
| Bagian unggah di halaman pengaturan | Diganti satu tombol nyala/mati |

**Yang TIDAK dihapus, dan alasannya:**

| Tetap ada | Kenapa |
|---|---|
| `POST /api/payments/:id/confirm` dan `/cancel` | Jalur resmi pelunasan. Provider dinamis nanti memanggilnya lewat webhook, dan baris `PENDING` lama di database toko masih butuh jalan keluar |
| `settlesImmediately()` | Titik tempat provider dinamis menjawab `false`. Menghapusnya karena "semua true" berarti membongkar satu-satunya tempat perbedaan itu bisa dinyatakan |
| Auto-cancel `PENDING` saat tutup shift | Mekanismenya tetap dijaga test (`tests/e2e-qris.test.ts` nomor 14). Layar kasir tidak lagi membuat baris `PENDING`, tapi webhook nanti akan |
| Dashboard kewajiban manual | Void atas QRIS yang sudah `PAID` tetap menyisakan kewajiban mengembalikan uang, dan alur satu langkah justru membuatnya lebih sering — karena tidak ada lagi tahap batal sebelum lunas |

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

   Tidak ada transisi keluar dari state terminal lewat jalur NORMAL.
   TEPAT SATU pengecualian ada di jalur VOID — lihat §4.1.
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

### 4.1 `PAID → CANCELLED` adalah transisi RESMI, bukan penimpaan

Kalimat di atas dulu hanya benar sebagai niat. Implementasinya melanggarnya:

```ts
// SEBELUM — tidak pernah menanyakan state machine, tanpa filter status
await tx.payment.updateMany({
  where: { transactionId: trx.id },
  data: { status: 'CANCELLED', failureReason: `Void: ${reason}` },
})
```

Akibatnya dua hal. Pertama, invarian "state terminal tidak punya transisi
keluar" ditegakkan `canTransition` untuk semua jalur **kecuali** satu-satunya
jalur yang benar-benar melanggarnya. Kedua, pembayaran yang sudah `EXPIRED` ikut
ditimpa menjadi `CANCELLED`, dan alasan aslinya hilang.

Sekarang transisinya dinyatakan **di dalam** state machine dan dipakai lewat
jalur resmi:

```ts
// SESUDAH — keabsahan diputuskan state machine, penulisannya dijaga database
for (const p of trx.payments) {
  const dari = p.status as PaymentStatus
  if (!canTransition(dari, 'CANCELLED', 'VOID')) continue   // EXPIRED/FAILED/CANCELLED dilewati
  const updated = await tx.payment.updateMany({
    where: { id: p.id, status: dari },                      // guarded: status belum bergeser
    data: { status: 'CANCELLED', failureReason: `Void: ${reason}` },
  })
  if (updated.count !== 1) throw new ConflictError('Pembayaran berubah di perangkat lain saat void diproses')
}
```

`canTransition(from, to, via)` menerima konteks operasi. `via` default `NORMAL`,
jadi setiap pemanggil lama mendapat aturan yang sama persis — pelonggaran hanya
mungkin kalau pemanggil **menyebutkan** bahwa ia sedang melakukan void.

| Transisi | NORMAL | VOID |
|---|---|---|
| `PENDING → PAID` | ✅ | ✅ |
| `PENDING → CANCELLED` | ✅ | ✅ |
| **`PAID → CANCELLED`** | ❌ | ✅ |
| `EXPIRED → CANCELLED` | ❌ | ❌ |
| `FAILED → CANCELLED` | ❌ | ❌ |
| `CANCELLED → PAID` | ❌ | ❌ |
| `PAID → PAID` | ❌ | ❌ |

Yang **tidak** berubah karena void, dan sengaja begitu: `paidAt` dan
`confirmedByUserId` tetap tersimpan. Setelah statusnya menjadi `CANCELLED`,
keduanya adalah satu-satunya bukti tersisa bahwa uangnya pernah benar-benar
masuk — dan dashboard kewajiban manual membacanya justru dari situ.

Invarian ini dijaga dua lapis test: perilakunya di `tests/void-transition.test.ts`
(termasuk void ganda dan void serentak), bentuk kodenya di
`src/lib/payment/no-auto-success.test.ts` — setiap berkas yang menulis status
pembayaran wajib menyebut `canTransition`, dan `payment.updateMany` tanpa filter
status ditolak.

### 4.1b Hasil bug hunting terhadap state machine

Diserang di `tests/attack.test.ts` dan `tests/e2e-qris.test.ts`:

| Serangan | Hasil |
|---|---|
| Dua void SERENTAK atas satu transaksi | Tepat satu berhasil; stok kembali tepat sekali (G3) |
| Konfirmasi ulang atas pembayaran `PAID` | `409`, stok tidak berkurang dua kali (e2e nomor 9) |
| Pembatalan atas pembayaran `PAID` | `409` (e2e nomor 10) |
| Dua checkout QRIS serentak, kunci sama | Tepat satu transaksi (e2e nomor 11) |
| Konfirmasi tanpa session | `401` (e2e nomor 13) |
| Void transaksi jasa | `409` — dan pesannya kini menyebut langkah yang benar-benar tersedia (lihat di bawah) |

**Temuan yang diperbaiki:** pesan penolakan void atas transaksi jasa dulu
berbunyi *"gunakan refund"*. Itu jalan buntu — refund dihitung dari baris
BARANG (`transaction_items`), sementara transaksi jasa murni tidak punya satu
pun, jadi layar refund terbuka tanpa apa pun untuk dipilih. Pesannya sekarang
menyebut jalur yang ada: catat pengembalian sebagai pengeluaran kas, lalu
cocokkan saldo provider lewat Saldo → Sesuaikan.

Keterbatasan yang tetap ada: **tidak ada mekanisme refund untuk baris jasa.**
Ini batas yang diakui, bukan bug yang tersembunyi — menambahkannya berarti
memutuskan lebih dulu apa artinya "mengembalikan" titipan yang sudah dibayarkan
ke provider, dan itu keputusan pemilik toko.

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
