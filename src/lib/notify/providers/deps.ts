import type { SettingKey, SettingValue } from '../../settings'

/**
 * Ketergantungan provider notifikasi, ditulis eksplisit.
 *
 * Alasannya sama dengan provider pembayaran (docs/qris.md §2.1): providernya
 * bisa diuji tanpa database dan tanpa internet. `fetch` yang di-inject membuat
 * bentuk payload Discord/Telegram bisa diperiksa tanpa pernah mengirim apa pun
 * ke luar — dan test yang diam-diam menembak webhook sungguhan adalah test yang
 * berbahaya untuk dimiliki.
 */
export interface NotifyDeps {
  readSetting: <K extends SettingKey>(key: K) => Promise<SettingValue<K>>
  fetch: typeof fetch
  /** Batas waktu request. Internet toko yang menggantung tidak boleh menahan antrean. */
  timeoutSignal: () => AbortSignal
  now: () => Date
}
