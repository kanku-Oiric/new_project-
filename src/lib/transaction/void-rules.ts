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

export const MANUAL_REFUND_WARNING =
  'Uang QRIS sudah masuk ke rekening toko. Void hanya membatalkan pencatatan dan mengembalikan stok. ' +
  'Pengembalian uang ke pelanggan harus dilakukan manual oleh pemilik lewat transfer atau tunai. ' +
  'Sistem tidak bisa menarik dana QRIS kembali.'
