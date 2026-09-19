import { AppError } from '../errors'
import { MoneyError, assertRupiah } from '../money'

/**
 * Perhitungan keranjang — modul murni, tanpa DB.
 *
 * Referensi: docs/architecture.md §4.1, docs/reporting.md §3.1
 *
 * Harga dan HPP TIDAK berasal dari client. Pemanggil di server memuatnya dari
 * database lalu menyerahkannya ke sini sebagai `PricedLine`. Client hanya boleh
 * menentukan produk mana, berapa banyak, dan berapa diskonnya.
 */

/** Masukan keranjang yang tidak sah — 400, bisa dibetulkan kasir. */
export class CartError extends MoneyError {}

/**
 * Pelanggaran invariant alokasi diskon — 500, karena ini BUG KODE, bukan
 * kesalahan kasir. Dibedakan dengan sengaja: menjawab 400 untuk kerusakan
 * internal akan menyuruh kasir membetulkan sesuatu yang tidak bisa ia betulkan.
 */
export class CartIntegrityError extends AppError {
  constructor(message: string) {
    super('INTERNAL', 500, message)
  }
}

/** Yang boleh ditentukan client. */
export interface CartLineInput {
  productId: string
  qty: number
  /** Diskon item dalam rupiah, untuk SATU BARIS (bukan per unit). */
  itemDiscount: number
}

/**
 * Baris dengan harga jual — cukup untuk menghitung apa yang dibayar pelanggan.
 *
 * Sengaja TANPA `unitCost`. Layar kasir dipakai karyawan di depan pelanggan,
 * dan harga beli adalah angka margin toko: ia tidak pernah dikirim ke browser.
 */
export interface DisplayLine extends CartLineInput {
  productName: string
  sku: string
  unitPrice: number
}

/** Baris lengkap di server, dengan HPP dari database. */
export interface PricedLine extends DisplayLine {
  unitCost: number
}

export interface ComputedDisplayLine extends DisplayLine {
  lineGross: number
  lineNet: number
  allocatedTxDiscount: number
  lineFinal: number
}

export interface ComputedLine extends ComputedDisplayLine {
  unitCost: number
  lineCogs: number
}

export interface CartDisplayTotals {
  lines: ComputedDisplayLine[]
  grossSubtotal: number
  itemDiscountTotal: number
  transactionDiscount: number
  netTotal: number
}

export interface CartTotals extends Omit<CartDisplayTotals, 'lines'> {
  lines: ComputedLine[]
  cogsTotal: number
}

/**
 * Bagi `total` ke beberapa bagian sebanding `weights`, dengan metode
 * LARGEST REMAINDER.
 *
 * Jaminannya: Σ hasil == `total` PERSIS. Pembagian proporsional biasa dengan
 * Math.round bisa menghasilkan Σ yang meleset satu rupiah ke atas atau ke
 * bawah — rupiah yang hilang atau tercipta dari udara. Pada transaksi, itu
 * membuat `netTotal` tidak sama dengan `Σ lineFinal`, dan nominal refund nanti
 * berbeda dari yang tercetak di struk pelanggan.
 *
 * Aritmatikanya memakai BigInt, bukan float. `total × weight` bisa melewati
 * Number.MAX_SAFE_INTEGER pada nominal besar, dan pembulatan float di tengah
 * pembagian justru sumber masalah yang sedang kita hindari.
 *
 * Sisa rupiah diberikan ke remainder terbesar; kalau seri, ke indeks lebih
 * kecil. Aturan seri ini ditetapkan supaya hasilnya deterministik — struk yang
 * dicetak ulang harus menampilkan angka yang sama persis.
 */
export function allocateLargestRemainder(total: number, weights: number[]): number[] {
  assertRupiah(total, 'total alokasi')
  for (const w of weights) assertRupiah(w, 'bobot alokasi')

  const weightSum = weights.reduce((a, b) => a + b, 0)

  if (weightSum === 0) {
    if (total !== 0) {
      throw new CartError('tidak bisa mengalokasikan diskon ketika seluruh bobot nol')
    }
    return weights.map(() => 0)
  }
  if (total === 0) return weights.map(() => 0)

  const totalBig = BigInt(total)
  const sumBig = BigInt(weightSum)

  const base: number[] = []
  const remainders: bigint[] = []

  for (const w of weights) {
    const numerator = totalBig * BigInt(w)
    const quotient = numerator / sumBig // semua non-negatif → sama dengan floor
    base.push(Number(quotient))
    remainders.push(numerator - quotient * sumBig)
  }

  let leftover = total - base.reduce((a, b) => a + b, 0)

  // Urutkan indeks: remainder terbesar dulu, seri dipecahkan indeks terkecil.
  const order = base
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = remainders[a] ?? 0n
      const rb = remainders[b] ?? 0n
      if (ra === rb) return a - b
      return rb > ra ? 1 : -1
    })

  for (const index of order) {
    if (leftover <= 0) break
    base[index] = (base[index] ?? 0) + 1
    leftover--
  }

  return base
}

/** Validasi satu baris sebelum dihitung. */
function validateLine(line: DisplayLine, position: number): void {
  const label = `baris ${position + 1} (${line.productName || line.productId})`

  if (!Number.isInteger(line.qty) || line.qty < 1) {
    throw new CartError(`${label}: qty harus bilangan bulat minimal 1`)
  }
  assertRupiah(line.unitPrice, `${label}: harga jual`)
  assertRupiah(line.itemDiscount, `${label}: diskon item`)

  const lineGross = line.unitPrice * line.qty
  if (line.itemDiscount > lineGross) {
    throw new CartError(
      `${label}: diskon item (${line.itemDiscount}) melebihi subtotal baris (${lineGross})`,
    )
  }
}

/**
 * Hitung keranjang dari sisi yang dibayar pelanggan.
 *
 * Urutannya penting dan ditetapkan di docs/architecture.md §4.1:
 *   lineGross = unitPrice × qty
 *   lineNet   = lineGross − itemDiscount
 *   allocatedTxDiscount = bagian transactionDiscount, bobot lineNet
 *   lineFinal = lineNet − allocatedTxDiscount
 *
 * Dipakai layar kasir DAN server. Satu implementasi untuk keduanya, sehingga
 * angka yang dilihat kasir sebelum menekan bayar tidak mungkin berbeda dari
 * angka yang tersimpan — server tetap menghitung ulang dari harga database,
 * jadi client tidak dipercaya, hanya tidak dibuat berbeda tanpa alasan.
 */
export function computeCartDisplay(
  lines: DisplayLine[],
  transactionDiscount: number,
): CartDisplayTotals {
  if (lines.length === 0) {
    throw new CartError('keranjang kosong')
  }
  assertRupiah(transactionDiscount, 'diskon transaksi')

  lines.forEach(validateLine)

  const lineGrossList = lines.map((l) => l.unitPrice * l.qty)
  const lineNetList = lines.map((l, i) => (lineGrossList[i] ?? 0) - l.itemDiscount)

  const grossSubtotal = lineGrossList.reduce((a, b) => a + b, 0)
  const itemDiscountTotal = lines.reduce((a, l) => a + l.itemDiscount, 0)
  const netAfterItemDiscount = lineNetList.reduce((a, b) => a + b, 0)

  if (transactionDiscount > netAfterItemDiscount) {
    throw new CartError(
      `diskon transaksi (${transactionDiscount}) melebihi total setelah diskon item (${netAfterItemDiscount})`,
    )
  }

  const allocations = allocateLargestRemainder(transactionDiscount, lineNetList)

  const computed: ComputedDisplayLine[] = lines.map((line, i) => {
    const lineGross = lineGrossList[i] ?? 0
    const lineNet = lineNetList[i] ?? 0
    const allocatedTxDiscount = allocations[i] ?? 0
    return {
      ...line,
      lineGross,
      lineNet,
      allocatedTxDiscount,
      lineFinal: lineNet - allocatedTxDiscount,
    }
  })

  const netTotal = grossSubtotal - itemDiscountTotal - transactionDiscount

  // Invariant #5c di docs/database.md. Dicek di sini, bukan cuma di test,
  // supaya ketidakcocokan tidak pernah sampai tertulis ke database.
  const sumLineFinal = computed.reduce((a, l) => a + l.lineFinal, 0)
  if (sumLineFinal !== netTotal) {
    throw new CartIntegrityError(
      `Σ lineFinal (${sumLineFinal}) tidak sama dengan netTotal (${netTotal}) — alokasi diskon rusak`,
    )
  }

  return { lines: computed, grossSubtotal, itemDiscountTotal, transactionDiscount, netTotal }
}

/**
 * Hitung keranjang lengkap dengan HPP. Hanya dipakai di server, karena hanya
 * server yang punya `unitCost`.
 */
export function computeCart(lines: PricedLine[], transactionDiscount: number): CartTotals {
  const display = computeCartDisplay(lines, transactionDiscount)

  const computed: ComputedLine[] = display.lines.map((line, i) => {
    const source = lines[i]
    if (!source) throw new CartError('baris keranjang hilang saat menghitung HPP')
    assertRupiah(source.unitCost, `baris ${i + 1} (${source.productName}): harga beli`)
    return { ...line, unitCost: source.unitCost, lineCogs: source.unitCost * source.qty }
  })

  return {
    ...display,
    lines: computed,
    cogsTotal: computed.reduce((a, l) => a + l.lineCogs, 0),
  }
}

/** Laba kotor transaksi. Bukan laba bersih — lihat docs/reporting.md §1. */
export function grossProfitOf(totals: CartTotals): number {
  return totals.netTotal - totals.cogsTotal
}
