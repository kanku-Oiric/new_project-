import type { PaymentMethod, PaymentStatus, ShiftStatus, TransactionStatus } from '../enums'

/**
 * Aturan kelayakan void — modul murni.
 *
 * Referensi: docs/architecture.md §9.2
 *
 * Hasilnya dipakai SERVER untuk menegakkan aturan dan dikirim ke UI untuk
 * menjelaskan alasannya. Satu sumber, jadi penjelasan di layar tidak mungkin
 * menyimpang dari yang benar-benar ditegakkan endpoint.
 */

export interface VoidEligibilityInput {
  status: TransactionStatus
  /** businessDate transaksi. */
  businessDate: string
  /** Status shift tempat transaksi itu dibuat. */
  shiftStatus: ShiftStatus
  /** Sudah ada refund atas transaksi ini? */
  hasRefund: boolean
  /** Transaksi ini memuat jasa pembayaran (token listrik, transfer, dll)? */
  hasService: boolean
  /** businessDate hari ini. */
  today: string
}

export interface VoidEligibility {
  canVoid: boolean
  /** Alasan yang ditampilkan di tempat tombol berada. null kalau boleh. */
  reason: string | null
}

/**
 * Tombol mati tanpa penjelasan membuat kasir menebak, lalu menelepon pemilik
 * untuk hal yang sebenarnya sudah punya jawaban. Karena itu setiap kondisi
 * punya pesannya sendiri, dan pesannya menyebut jalan keluar.
 */
export function checkVoidEligibility(input: VoidEligibilityInput): VoidEligibility {
  if (input.status === 'VOIDED') {
    return { canVoid: false, reason: 'Transaksi sudah dibatalkan' }
  }
  if (input.status === 'CANCELLED') {
    return { canVoid: false, reason: 'Transaksi sudah dibatalkan' }
  }
  if (input.status === 'PENDING') {
    return { canVoid: false, reason: 'Transaksi belum selesai — gunakan Batalkan' }
  }
  if (input.hasRefund) {
    return {
      canVoid: false,
      reason: 'Transaksi sudah pernah di-refund — gunakan refund untuk sisanya',
    }
  }
  // Barang bisa dikembalikan ke rak. Token listrik yang sudah terbit tidak bisa
  // ditarik kembali, dan saldo provider sudah benar-benar terpakai. Void yang
  // "mengembalikan" saldo hanya akan membuat angka tercatat berbeda dari angka
  // asli di aplikasi Shopee — dan selisih itu baru ketahuan saat rekonsiliasi,
  // tanpa ada yang ingat sebabnya.
  //
  // Yang benar adalah refund: uangnya memang harus keluar dari toko, dan
  // pemilik yang memutuskan berapa, karena titipannya sudah terlanjur dibayarkan.
  if (input.hasService) {
    return {
      canVoid: false,
      reason:
        'Transaksi memuat jasa pembayaran yang sudah dibayarkan ke provider — gunakan refund, dan sesuaikan saldo provider secara manual',
    }
  }
  if (input.businessDate !== input.today) {
    return { canVoid: false, reason: 'Transaksi bukan hari ini — gunakan refund' }
  }
  // Void mengubah penjualan tunai sebuah shift. Kalau shift sudah ditutup dan
  // kasnya direkonsiliasi, void akan merusak angka yang sudah dinyatakan final.
  if (input.shiftStatus === 'CLOSED') {
    return { canVoid: false, reason: 'Shift sudah ditutup — gunakan refund' }
  }
  return { canVoid: true, reason: null }
}

/**
 * Apakah void ini menyisakan kewajiban pengembalian uang manual.
 *
 * Sistem ini tidak punya jalur ke rekening toko. Untuk QRIS yang sudah PAID,
 * void hanya membereskan pencatatan dan stok — dananya tetap di rekening dan
 * harus dikembalikan pemilik lewat transfer atau tunai.
 */
export function voidNeedsManualRefund(
  method: PaymentMethod,
  status: PaymentStatus,
): boolean {
  return status === 'PAID' && method !== 'CASH'
}

/**
 * Alasan yang ditulis penutupan shift saat membatalkan transaksi terlantar.
 *
 * Satu sumber, karena dashboard MENCARI baris berdasarkan kalimat ini untuk
 * menyusun daftar "periksa mutasi rekening". Kalau kalimatnya ditulis dua kali,
 * mengubahnya di satu tempat akan membuat daftar itu sunyi tanpa ada yang tahu —
 * dan daftar yang sunyi terlihat sama seperti daftar yang kosong.
 */
export const AUTO_CANCEL_REASON = 'Dibatalkan otomatis saat tutup shift'

export const MANUAL_REFUND_WARNING =
  'Uang QRIS sudah masuk ke rekening toko. Void hanya membatalkan pencatatan dan mengembalikan stok. ' +
  'Pengembalian uang ke pelanggan harus dilakukan manual oleh pemilik lewat transfer atau tunai. ' +
  'Sistem tidak bisa menarik dana QRIS kembali.'
