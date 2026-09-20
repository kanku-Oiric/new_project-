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
 * Operasi yang meminta transisi.
 *
 *   NORMAL  alur biasa: pelunasan, pembatalan, kedaluwarsa.
 *   VOID    pembatalan SELURUH transaksi oleh pemilik, dengan PIN, audit, dan
 *           pengembalian stok dalam satu DB transaction.
 *
 * Konteks ini ada karena `VOID` adalah satu-satunya operasi bisnis yang sah
 * keluar dari `PAID`, dan keabsahan itu harus dinyatakan DI DALAM state machine —
 * bukan dengan melewatinya. Lihat `VOID_EXCEPTION` di bawah.
 */
export type TransitionVia = 'NORMAL' | 'VOID'

/**
 * Satu-satunya pengecualian terhadap aturan "state terminal tidak punya transisi
 * keluar", dan ia dinyatakan di sini supaya bisa dibaca, diuji, dan dihitung.
 *
 * `PAID → CANCELLED` lewat void adalah transisi bisnis yang sah:
 *
 *  - pelanggan mengembalikan barang di hari yang sama, sebelum shift ditutup;
 *  - pemilik memberi PIN, jadi ada otorisasi manusia yang tercatat;
 *  - stok dikembalikan dan seluruhnya dalam satu DB transaction;
 *  - uang QRIS TETAP di rekening toko — void tidak menariknya kembali, dan
 *    kewajiban mengembalikannya dilacak di dashboard (architecture.md §19).
 *
 * Yang TIDAK sah dan tetap ditolak: `PAID → CANCELLED` di luar void, dan seluruh
 * transisi keluar dari `EXPIRED`, `CANCELLED`, serta `FAILED` — termasuk lewat
 * void. Void atas transaksi yang pembayarannya sudah kedaluwarsa tidak boleh
 * menulis ulang sejarah pembayaran itu.
 */
const VOID_EXCEPTION: ReadonlyArray<{ from: PaymentStatus; to: PaymentStatus }> = [
  { from: 'PAID', to: 'CANCELLED' },
]

/**
 * Satu-satunya definisi transisi yang sah, berlaku untuk SEMUA provider —
 * tunai, QRIS statis, dan nanti Midtrans/Xendit.
 *
 *   PENDING → PAID | EXPIRED | CANCELLED | FAILED
 *   state terminal tidak punya transisi keluar,
 *   KECUALI satu pengecualian yang dinyatakan di `VOID_EXCEPTION`.
 *
 * Fungsi ini TIDAK cukup sendirian. Ia tidak bisa mencegah race: dua kasir yang
 * menekan "Pembayaran diterima" bersamaan akan sama-sama membaca PENDING dan
 * sama-sama lolos di sini. Lapis kedua ada di database, berupa guarded update
 * (`updateMany where status=<status lama>` lalu cek count === 1).
 *
 * `via` default `NORMAL`, jadi seluruh pemanggil lama mendapat aturan yang sama
 * persis seperti sebelumnya — pelonggaran hanya bisa terjadi kalau pemanggil
 * MENYEBUTKAN bahwa ia sedang melakukan void.
 */
export function canTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  via: TransitionVia = 'NORMAL',
): boolean {
  if (from === to) return false

  if (isTerminal(from)) {
    if (via !== 'VOID') return false
    return VOID_EXCEPTION.some((t) => t.from === from && t.to === to)
  }

  return isTerminal(to)
}

export function assertTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  via: TransitionVia = 'NORMAL',
): void {
  if (!canTransition(from, to, via)) {
    throw new PaymentError(`transisi pembayaran tidak sah: ${from} → ${to} (via ${via})`)
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
