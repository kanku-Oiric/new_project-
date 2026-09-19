import { MoneyError, assertRupiah } from '../money'

/**
 * Perhitungan refund — modul murni, tanpa DB.
 *
 * Referensi: docs/reporting.md §3.2
 */

export class RefundError extends MoneyError {}

/** Keadaan satu baris transaksi asal, termasuk yang sudah pernah di-refund. */
export interface RefundableItem {
  transactionItemId: string
  productName: string
  unitCost: number
  /** qty pada transaksi asal. */
  qty: number
  /** Yang benar-benar dibayar untuk baris ini, setelah semua diskon. */
  lineFinal: number
  /** Akumulatif qty yang sudah di-refund sebelumnya. */
  refundedQty: number
  /** Akumulatif nominal yang sudah di-refund sebelumnya. */
  refundedAmount: number
}

export interface RefundLineInput {
  transactionItemId: string
  /** qty yang di-refund SEKARANG (bukan kumulatif). */
  qty: number
}

export interface ComputedRefundLine {
  transactionItemId: string
  productName: string
  qty: number
  amount: number
  cogsAmount: number
}

export interface RefundTotals {
  lines: ComputedRefundLine[]
  amount: number
  cogsAmount: number
}

/** Sisa qty yang masih boleh di-refund. */
export function refundableQty(item: RefundableItem): number {
  return item.qty - item.refundedQty
}

/**
 * Nominal refund untuk satu baris, memakai ATURAN TELESKOPIK.
 *
 *     amount = floor(lineFinal × refundedQtyKumulatif / qty) − refundedAmountSebelumnya
 *
 * Bukan "hitung per refund lalu bulatkan", melainkan "hitung total yang
 * seharusnya sudah di-refund, lalu kurangi yang sudah dibayarkan". Dengan cara
 * ini pembulatan tidak pernah menumpuk, dan berapa pun urutan serta jumlah
 * refund sebagiannya, refund penuh selalu == lineFinal PERSIS.
 *
 * Pembagian naif merugikan toko. Contoh dokumen: lineFinal 18.131, qty 3.
 * round(18.131/3) = 6.044 tiga kali menghasilkan 18.132 — satu rupiah lebih
 * banyak daripada yang pernah dibayar pelanggan.
 *
 * Aritmatikanya BigInt supaya `lineFinal × qty` tidak kehilangan presisi pada
 * nominal besar.
 */
export function refundAmountFor(item: RefundableItem, qtyNow: number): number {
  if (!Number.isInteger(qtyNow) || qtyNow < 1) {
    throw new RefundError(`${item.productName}: qty refund harus bilangan bulat minimal 1`)
  }

  const cumulative = item.refundedQty + qtyNow
  if (cumulative > item.qty) {
    throw new RefundError(
      `${item.productName}: refund ${qtyNow} melebihi sisa (${refundableQty(item)} dari ${item.qty})`,
    )
  }

  const target = Number(
    (BigInt(item.lineFinal) * BigInt(cumulative)) / BigInt(item.qty),
  )
  const amount = target - item.refundedAmount

  if (amount < 0) {
    throw new RefundError(
      `${item.productName}: nominal refund negatif — data refundedAmount tidak konsisten`,
    )
  }
  return amount
}

/** HPP yang ikut kembali. Perkalian integer, tanpa pembulatan. */
export function refundCogsFor(item: RefundableItem, qtyNow: number): number {
  return item.unitCost * qtyNow
}

/** Hitung seluruh refund sekaligus. */
export function computeRefund(
  items: RefundableItem[],
  requested: RefundLineInput[],
): RefundTotals {
  if (requested.length === 0) {
    throw new RefundError('tidak ada item yang di-refund')
  }

  const byId = new Map(items.map((i) => [i.transactionItemId, i]))
  const seen = new Set<string>()
  const lines: ComputedRefundLine[] = []

  for (const req of requested) {
    if (seen.has(req.transactionItemId)) {
      throw new RefundError(`item ${req.transactionItemId} muncul dua kali dalam satu refund`)
    }
    seen.add(req.transactionItemId)

    const item = byId.get(req.transactionItemId)
    if (!item) {
      throw new RefundError(`item ${req.transactionItemId} bukan bagian dari transaksi ini`)
    }

    assertRupiah(item.lineFinal, `${item.productName}: lineFinal`)

    lines.push({
      transactionItemId: item.transactionItemId,
      productName: item.productName,
      qty: req.qty,
      amount: refundAmountFor(item, req.qty),
      cogsAmount: refundCogsFor(item, req.qty),
    })
  }

  return {
    lines,
    amount: lines.reduce((a, l) => a + l.amount, 0),
    cogsAmount: lines.reduce((a, l) => a + l.cogsAmount, 0),
  }
}

/** Refund seluruh sisa item — jalur "Refund semua" di layar. */
export function refundAllRemaining(items: RefundableItem[]): RefundLineInput[] {
  return items
    .filter((i) => refundableQty(i) > 0)
    .map((i) => ({ transactionItemId: i.transactionItemId, qty: refundableQty(i) }))
}
