import type { PaymentProvider, ProviderDeps, ProviderReadiness } from '../provider'

/**
 * QRIS statis — satu-satunya provider QRIS di v1.
 *
 * Referensi: docs/qris.md §3
 *
 * Menampilkan gambar QR milik toko, lalu kasir menekan "Pembayaran diterima"
 * setelah melihat notifikasi masuk di HP-nya. Tidak ada payment gateway, tidak
 * ada webhook, tidak ada pengecekan otomatis, dan tidak ada timer yang mengubah
 * status. Karena itu labelnya berbunyi "konfirmasi manual kasir", bukan
 * "terintegrasi".
 */

/** Dipakai UI apa adanya. Satu-satunya tempat kalimat ini ditulis. */
export const QRIS_STATIC_ACTIVE_LABEL = 'QRIS statis aktif (konfirmasi manual kasir)'
export const QRIS_STATIC_INACTIVE_LABEL = 'QRIS belum dikonfigurasi'

export function createStaticQrisProvider(deps: ProviderDeps): PaymentProvider {
  async function readiness(): Promise<ProviderReadiness> {
    const [enabled, imagePath] = await Promise.all([
      deps.readSetting('qrisEnabled'),
      deps.readSetting('qrisImagePath'),
    ])

    // Dua syarat, dan keduanya harus benar. Menyalakan QRIS tanpa gambar QR
    // berarti kasir menghadap layar kosong sementara pelanggan menunggu.
    if (!enabled) {
      return {
        configured: false,
        label: QRIS_STATIC_INACTIVE_LABEL,
        hint: imagePath
          ? 'Gambar QR sudah ada, tetapi QRIS masih dimatikan di Pengaturan.'
          : 'Pemilik perlu mengunggah gambar QR statis lalu menyalakan QRIS di Pengaturan.',
      }
    }
    if (!imagePath) {
      return {
        configured: false,
        label: QRIS_STATIC_INACTIVE_LABEL,
        hint: 'QRIS sudah dinyalakan tetapi gambar QR belum diunggah.',
      }
    }

    return { configured: true, label: QRIS_STATIC_ACTIVE_LABEL, hint: null }
  }

  return {
    name: 'qris-static',
    method: 'QRIS_STATIC',
    settlesOnCreate: false,

    async isConfigured() {
      return (await readiness()).configured
    },

    describe: readiness,

    async createPayment() {
      // Tidak ada panggilan jaringan: QR statis tidak dibuat per transaksi.
      return {}
    },

    async checkStatus(ref) {
      // Membaca status TERSIMPAN. Secara konstruksi tidak punya kemampuan
      // memajukan PENDING menjadi PAID — fungsi ini tidak menulis apa pun.
      return deps.readStoredStatus(ref.paymentId)
    },
  }
}
