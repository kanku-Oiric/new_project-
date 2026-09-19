import { MoneyError, assertRupiah } from '../money'

/**
 * Rekonsiliasi kas shift — modul murni, tanpa DB.
 *
 * Referensi: docs/reporting.md §4
 *
 * Satu shift per kasir: tiap kasir punya kas awal dan laci/kantong sendiri,
 * sehingga selisihnya bisa ditelusuri ke orangnya.
 */

export class ShiftError extends MoneyError {}

export interface ShiftCashInputs {
  openingCash: number
  /**
   * Σ Payment.amount — method CASH, status PAID, transaksi BUKAN VOIDED.
   *
   * Yang dijumlahkan `amount`, BUKAN `amountTendered`. Kalau pelanggan
   * menyerahkan Rp 100.000 untuk belanja Rp 48.500, yang masuk laci secara neto
   * hanya Rp 48.500 — sisanya keluar lagi sebagai kembalian. Menjumlahkan uang
   * yang diserahkan akan melipatgandakan angka kas.
   */
  cashSales: number
  /** Σ Refund.amount — method CASH, pada shift INI (bukan shift penjualan asal). */
  cashRefunds: number
  /** Σ Expense.amount — paidFrom CASH_DRAWER, belum dihapus. */
  cashExpenses: number
}

/**
 * expectedCash = kas awal + penjualan tunai − refund tunai − pengeluaran kas
 *
 * Boleh negatif: kalau pengeluaran melebihi kas awal ditambah penjualan, itu
 * keadaan nyata yang harus terlihat, bukan dipaksa jadi nol.
 */
export function expectedCash(inputs: ShiftCashInputs): number {
  assertRupiah(inputs.openingCash, 'kas awal')
  assertRupiah(inputs.cashSales, 'penjualan tunai')
  assertRupiah(inputs.cashRefunds, 'refund tunai')
  assertRupiah(inputs.cashExpenses, 'pengeluaran kas')

  return inputs.openingCash + inputs.cashSales - inputs.cashRefunds - inputs.cashExpenses
}

/**
 * difference = uang dihitung − uang seharusnya.
 *
 * Negatif berarti kurang, positif berarti lebih. Keduanya disimpan apa adanya:
 * tidak pernah dibulatkan ke nol, tidak pernah "dikoreksi" otomatis. Selisih
 * yang disembunyikan adalah selisih yang tidak akan pernah diperiksa.
 */
export function cashDifference(countedCash: number, expected: number): number {
  assertRupiah(countedCash, 'uang dihitung')
  if (!Number.isInteger(expected)) {
    throw new ShiftError(`expectedCash harus integer, dapat ${expected}`)
  }
  return countedCash - expected
}

export interface ShiftSummary extends ShiftCashInputs {
  expectedCash: number
  countedCash: number | null
  difference: number | null
  transactionCount: number
  nonCashSales: number
  pendingCount: number
}

export interface ShiftSummaryInputs extends ShiftCashInputs {
  countedCash?: number | null
  transactionCount: number
  nonCashSales: number
  /** Transaksi PENDING milik shift ini — akan dibatalkan saat tutup shift. */
  pendingCount: number
}

export function buildShiftSummary(inputs: ShiftSummaryInputs): ShiftSummary {
  const expected = expectedCash(inputs)
  const counted = inputs.countedCash ?? null

  return {
    openingCash: inputs.openingCash,
    cashSales: inputs.cashSales,
    cashRefunds: inputs.cashRefunds,
    cashExpenses: inputs.cashExpenses,
    expectedCash: expected,
    countedCash: counted,
    difference: counted === null ? null : cashDifference(counted, expected),
    transactionCount: inputs.transactionCount,
    nonCashSales: inputs.nonCashSales,
    pendingCount: inputs.pendingCount,
  }
}
