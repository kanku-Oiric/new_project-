import type { PaymentProvider, ProviderDeps } from '../provider'

/**
 * Tunai.
 *
 * Ada di registry supaya tidak ada metode pembayaran yang hidup di luar
 * interface yang sama. Tanpa ini, `Record<PaymentMethod, PaymentProvider>` di
 * registry tidak bisa lengkap, dan "semua metode lewat satu jalur" jadi klaim
 * yang tidak ditegakkan compiler.
 */
export function createCashProvider(deps: ProviderDeps): PaymentProvider {
  return {
    name: 'cash',
    method: 'CASH',
    settlesOnCreate: true,

    async isConfigured() {
      return true
    },

    async describe() {
      return {
        configured: true,
        label: 'Tunai — selalu aktif, tidak perlu dikonfigurasi',
        hint: null,
      }
    },

    async createPayment() {
      // Tidak ada dunia luar yang perlu dihubungi untuk uang kertas.
      return {}
    },

    async checkStatus(ref) {
      return deps.readStoredStatus(ref.paymentId)
    },
  }
}
