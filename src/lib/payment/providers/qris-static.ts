import type { PaymentProvider, ProviderDeps, ProviderReadiness } from '../provider'

/**
 * QRIS soundbox — satu-satunya provider QRIS di v1.
 *
 * Referensi: docs/qris.md §3
 *
 * Toko memakai QRIS soundbox: kotak kecil yang BERBUNYI saat pembayaran masuk,
 * dengan QR yang sudah tertempel permanen di meja. Pelanggan scan QR di meja
 * tanpa melihat layar kasir sama sekali.
 *
 * Konsekuensinya seluruh alur PENDING hilang, dan itu penyederhanaan yang
 * dituntut kenyataan, bukan pemangkasan fitur:
 *
 *   dulu  kasir tekan QRIS → layar menampilkan gambar QR → pelanggan scan →
 *         kasir dengar notifikasi di HP → kasir tekan "Pembayaran diterima"
 *
 *   kini  pelanggan scan QR di meja → soundbox berbunyi → kasir tekan QRIS
 *
 * Kasir menekan tombolnya SETELAH bunyi terdengar, jadi pada saat ia menekan,
 * uangnya sudah masuk. Transaksi PENDING yang menunggu konfirmasi kedua hanya
 * akan menjadi transaksi terlantar saat kasir lupa menekan tombol kedua — dan
 * itulah yang selama ini dibersihkan auto-cancel saat tutup shift.
 *
 * Yang TIDAK berubah, dan sengaja dipertahankan:
 *
 *   - `PaymentProvider` sebagai interface. Provider dinamis (Midtrans/Xendit)
 *     nanti tinggal mendaftar di registry dengan `settlesOnCreate: false`, dan
 *     alur PENDING → PAID lewat webhook masih ada di state machine, tidak ikut
 *     dihapus.
 *   - `canTransition` dan guarded update. Melunaskan tetap melewati gerbang
 *     yang sama seperti tunai, termasuk penolakan pelunasan ganda.
 *   - Tidak ada timer dan tidak ada apa pun yang mengubah status sendiri.
 *     Yang berubah cuma JUMLAH LANGKAH manusia: dari dua menjadi satu.
 */

/** Dipakai UI apa adanya. Satu-satunya tempat kalimat ini ditulis. */
export const QRIS_STATIC_ACTIVE_LABEL = 'QRIS soundbox aktif (kasir menekan setelah bunyi)'
export const QRIS_STATIC_INACTIVE_LABEL = 'QRIS belum dinyalakan'

export function createStaticQrisProvider(deps: ProviderDeps): PaymentProvider {
  async function readiness(): Promise<ProviderReadiness> {
    const enabled = await deps.readSetting('qrisEnabled')

    // Satu syarat saja sekarang. Dulu ada dua, karena layar kasir harus punya
    // gambar QR untuk ditunjukkan; dengan QR yang tertempel di meja, gambar itu
    // tidak pernah dibuka siapa pun.
    if (!enabled) {
      return {
        configured: false,
        label: QRIS_STATIC_INACTIVE_LABEL,
        hint: 'Pemilik menyalakannya di Pengaturan setelah QR soundbox terpasang di meja.',
      }
    }

    return { configured: true, label: QRIS_STATIC_ACTIVE_LABEL, hint: null }
  }

  return {
    name: 'qris-static',
    method: 'QRIS_STATIC',
    // Berubah dari false. Kasir menekan tombol ini SETELAH soundbox berbunyi,
    // jadi uangnya sudah masuk saat baris pembayaran dibuat — sama persis
    // seperti tunai, dan lewat settleTransaction yang sama.
    settlesOnCreate: true,

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
