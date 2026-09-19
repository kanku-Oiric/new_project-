import type { ReportChannel } from '../enums'

/**
 * Pengiriman laporan ke luar — kontrak yang sama untuk semua saluran.
 *
 * Referensi: docs/architecture.md §11
 *
 * `ReportMessage` adalah objek TERSTRUKTUR, bukan string yang sudah diformat.
 * Kalau yang dioper string, setiap provider baru akan membawa salinan format
 * angkanya sendiri, dan cepat atau lambat salah satunya akan memformat rupiah
 * dengan cara yang berbeda dari struk.
 */

export interface MessageRow {
  label: string
  /** Sudah diformat untuk dibaca manusia. Provider tidak memformat angka. */
  value: string
  /** Baris penting yang boleh ditonjolkan provider yang mendukungnya. */
  emphasis?: boolean
}

export interface MessageSection {
  label: string
  rows: MessageRow[]
}

export interface ReportMessage {
  title: string
  periodLabel: string
  sections: MessageSection[]
  /** Catatan kaki, mis. penjelasan atribusi refund. */
  footnotes?: string[]
  /**
   * Teks analisis AI. Hanya terisi kalau AI aktif DAN hasilnya lolos validasi.
   * Tidak ada placeholder dan tidak ada pesan error yang ikut terkirim ke
   * pemilik (docs/reporting.md §5.2).
   */
  aiInsight?: string
}

export interface ProviderReadiness {
  configured: boolean
  /** Ditampilkan apa adanya di UI. Tidak pernah mengklaim "tersambung". */
  label: string
  hint: string | null
}

export interface NotificationProvider {
  readonly channel: ReportChannel
  readonly name: string
  isConfigured(): Promise<boolean>
  describe(): Promise<ProviderReadiness>
  /** Melempar `SendError` kalau gagal. Sukses berarti benar-benar terkirim. */
  send(message: ReportMessage): Promise<void>
}

/**
 * Kegagalan pengiriman, dengan satu informasi yang menentukan tindakan
 * selanjutnya: apakah mencoba lagi masuk akal.
 *
 * Token salah (401) tidak akan menjadi benar setelah lima kali percobaan —
 * mencoba lagi hanya menunda pesan gagal yang seharusnya segera dibaca pemilik.
 */
export class SendError extends Error {
  readonly retryable: boolean
  readonly status: number | null
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    opts: { retryable: boolean; status?: number | null; retryAfterMs?: number | null },
  ) {
    super(message)
    this.name = 'SendError'
    this.retryable = opts.retryable
    this.status = opts.status ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
  }
}
