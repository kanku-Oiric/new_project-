import type { PaymentProvider, ProviderDeps } from '../provider'

/**
 * Serah tunai — uang yang KELUAR dari laci.
 *
 * Dipakai transaksi tarik tunai: pelanggan transfer ke rekening toko, lalu toko
 * menyerahkan uang kertas. Arah uangnya berlawanan dengan seluruh metode lain,
 * tapi bentuknya tetap satu baris `Payment` dengan state machine yang sama —
 * itu sebabnya ia ada di registry ini dan bukan jadi jalur tersendiri.
 *
 * `Payment.amount` tetap POSITIF (= uang yang diserahkan). Yang menyatakan
 * arahnya adalah `method`, bukan tanda angkanya, karena angka negatif akan
 * menabrak `assertRupiah` di seluruh modul kas dan menyebar ke laporan.
 */
export function createCashOutProvider(deps: ProviderDeps): PaymentProvider {
  return {
    name: 'cash-out',
    method: 'CASH_OUT',
    // Uang diserahkan saat itu juga; tidak ada yang perlu dikonfirmasi nanti.
    settlesOnCreate: true,

    async isConfigured() {
      return true
    },

    async describe() {
      return {
        configured: true,
        label: 'Serah tunai — uang diserahkan ke pelanggan',
        hint: null,
      }
    },

    async createPayment() {
      return {}
    },

    async checkStatus(ref) {
      return deps.readStoredStatus(ref.paymentId)
    },
  }
}
