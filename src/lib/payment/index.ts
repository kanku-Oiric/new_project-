import { MoneyError, assertRupiah } from '../money'
import {
  TERMINAL_PAYMENT_STATUSES,
  type PaymentMethod,
  type PaymentStatus,
} from '../enums'

/**
 * Pembayaran — modul murni, tanpa DB.
 *
 * Referensi: docs/qris.md §4, docs/architecture.md §8
 */

export class PaymentError extends MoneyError {}

// ─────────────────────────────── State machine ───────────────────────────────

function isTerminal(status: PaymentStatus): boolean {
  return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(status)
}

/**
 * Satu-satunya definisi transisi yang sah, berlaku untuk SEMUA provider —
 * tunai, QRIS statis, dan nanti Midtrans/Xendit.
 *
 *   PENDING → PAID | EXPIRED | CANCELLED | FAILED
 *   state terminal tidak punya transisi keluar, tanpa pengecualian.
 *
 * Fungsi ini TIDAK cukup sendirian. Ia tidak bisa mencegah race: dua kasir yang
 * menekan "Pembayaran diterima" bersamaan akan sama-sama membaca PENDING dan
 * sama-sama lolos di sini. Lapis kedua ada di database, berupa guarded update
 * (`updateMany where status='PENDING'` lalu cek count === 1).
 */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return false
  if (isTerminal(from)) return false
  return isTerminal(to)
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new PaymentError(`transisi pembayaran tidak sah: ${from} → ${to}`)
  }
}

/** Apakah metode ini selesai seketika saat transaksi dibuat. */
export function settlesImmediately(method: PaymentMethod): boolean {
  // Tunai: uang sudah di tangan kasir saat tombol ditekan.
  // QRIS statis: menunggu kasir melihat notifikasi masuk di HP-nya, lalu
  // menekan konfirmasi. Tidak pernah otomatis.
  return method === 'CASH'
}

// ─────────────────────────────── Tunai ───────────────────────────────

export interface CashCalculation {
  amount: number
  amountTendered: number
  changeAmount: number
  sufficient: boolean
  shortfall: number
}

/**
 * Hitung kembalian.
 *
 * Mengembalikan objek alih-alih melempar saat uang kurang, karena layar kasir
 * perlu menampilkan kekurangannya secara langsung sambil kasir mengetik —
 * melempar exception untuk keadaan setengah-ketik itu salah tempat.
 */
export function calculateCash(amount: number, amountTendered: number): CashCalculation {
  assertRupiah(amount, 'nominal transaksi')
  assertRupiah(amountTendered, 'uang diterima')

  const sufficient = amountTendered >= amount
  return {
    amount,
    amountTendered,
    changeAmount: sufficient ? amountTendered - amount : 0,
    sufficient,
    shortfall: sufficient ? 0 : amount - amountTendered,
  }
}

/** Dipakai di titik penulisan ke DB, di mana uang kurang memang tidak sah. */
export function assertCashSufficient(amount: number, amountTendered: number): CashCalculation {
  const calc = calculateCash(amount, amountTendered)
  if (!calc.sufficient) {
    throw new PaymentError(
      `uang diterima (${amountTendered}) kurang dari total (${amount}), kurang ${calc.shortfall}`,
    )
  }
  return calc
}

export interface QuickCashOption {
  label: string
  value: number
  /** true kalau ini uang pas, untuk penandaan di UI. */
  exact: boolean
}

/** Pecahan rupiah yang benar-benar beredar dan lazim diserahkan pelanggan. */
const NOTES = [5_000, 10_000, 20_000, 50_000, 100_000] as const

/**
 * Tombol cepat pembayaran tunai.
 *
 * Selalu diawali "Uang pas", lalu pecahan yang lebih besar dari total. Tujuannya
 * memotong pengetikan pada kasus yang paling sering terjadi, bukan menyediakan
 * setiap kemungkinan — daftar panjang justru memperlambat kasir.
 */
export function quickCashOptions(amount: number, limit = 4): QuickCashOption[] {
  assertRupiah(amount, 'nominal transaksi')

  const options: QuickCashOption[] = [{ label: 'Uang pas', value: amount, exact: true }]

  for (const note of NOTES) {
    if (options.length >= limit) break
    if (note > amount) {
      options.push({ label: formatShort(note), value: note, exact: false })
    }
  }

  // Kalau totalnya besar (mis. Rp 235.000), tidak ada pecahan tunggal yang
  // cukup. Tawarkan pembulatan ke atas ke kelipatan 50rb dan 100rb berikutnya.
  if (options.length < limit) {
    for (const step of [50_000, 100_000]) {
      if (options.length >= limit) break
      const rounded = Math.ceil(amount / step) * step
      if (rounded > amount && !options.some((o) => o.value === rounded)) {
        options.push({ label: formatShort(rounded), value: rounded, exact: false })
      }
    }
  }

  return options
}

function formatShort(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}jt`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}rb`
  return String(value)
}
