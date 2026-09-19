import type { PaymentMethod, PaymentStatus } from '../enums'
import type { SettingKey, SettingValue } from '../settings'

/**
 * Batas antara sistem kasir dan dunia luar pembayaran.
 *
 * Referensi: docs/qris.md §2 dan §6
 *
 * Yang SENGAJA tidak ada di interface ini: wewenang mengubah stok, status
 * transaksi, atau status pembayaran. Provider hanya melaporkan apa yang terjadi
 * di luar; keputusan menulis ke database tetap milik `settleTransactionInTx`.
 * Kalau setiap metode pembayaran punya jalur settle-nya sendiri, setiap provider
 * baru akan membawa salinan bug-nya sendiri.
 */

export interface PaymentRef {
  paymentId: string
  /**
   * Id di sisi provider. `null` untuk QRIS statis karena QR-nya milik toko dan
   * tidak dibuat per transaksi — tidak ada id luar yang bisa dirujuk.
   */
  externalId: string | null
}

export interface CreatePaymentInput {
  /** Integer rupiah penuh, sama seperti di seluruh sistem. */
  amount: number
  transactionId: string
}

export interface CreatePaymentResult {
  /**
   * String QRIS yang dirender jadi gambar oleh provider dinamis. Tidak dipakai
   * StaticQrisProvider: gambarnya diambil dari setting toko.
   */
  qrPayload?: string
  externalId?: string
}

/**
 * Keadaan provider yang ditampilkan APA ADANYA di UI.
 *
 * `label` tinggal di provider, bukan di komponen, supaya tidak ada halaman yang
 * bisa menuliskan klaim lebih berani daripada kenyataannya (docs/qris.md §3.2).
 */
export interface ProviderReadiness {
  configured: boolean
  label: string
  /** Apa yang harus dilakukan supaya siap. `null` kalau sudah siap. */
  hint: string | null
}

export interface PaymentProvider {
  readonly name: string
  readonly method: PaymentMethod

  /**
   * `true` berarti pembayaran selesai pada request yang membuat transaksinya
   * (tunai: uang sudah di tangan kasir saat tombol ditekan). `false` berarti
   * transaksi berhenti di PENDING dan butuh request konfirmasi TERSENDIRI.
   *
   * Pada keduanya, PAID hanya pernah terjadi karena manusia mengirim request.
   * Bedanya cuma request yang mana — checkout itu sendiri, atau konfirmasi
   * terpisah. Tidak ada jalur ketiga.
   */
  readonly settlesOnCreate: boolean

  isConfigured(): Promise<boolean>
  describe(): Promise<ProviderReadiness>

  /** Dipanggil saat transaksi dibuat. TIDAK BOLEH menandai PAID. */
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>

  /**
   * Status terkini menurut provider. Tidak pernah memajukan state sendiri —
   * StaticQrisProvider menjawab dengan status yang tersimpan di database.
   * `null` kalau pembayarannya tidak dikenal.
   */
  checkStatus(ref: PaymentRef): Promise<PaymentStatus | null>
}

/**
 * Ketergantungan provider ditulis eksplisit, bukan diimpor langsung, karena dua
 * alasan: providernya bisa diuji tanpa database, dan `db` bisa diarahkan ke
 * transaction client saat dipakai di dalam `$transaction`.
 */
export interface ProviderDeps {
  readSetting: <K extends SettingKey>(key: K) => Promise<SettingValue<K>>
  readStoredStatus: (paymentId: string) => Promise<PaymentStatus | null>
}
