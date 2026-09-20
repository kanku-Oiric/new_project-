import { MoneyError } from '../money'
import type {
  ExpenseSource,
  PaymentMethod,
  RefundMethod,
  ShiftStatus,
  TransactionStatus,
} from '../enums'

/**
 * Agregasi laporan — modul murni, tanpa DB dan tanpa `new Date()`.
 *
 * Referensi: docs/reporting.md §1, §2, §5
 *
 * Dua aturan yang menentukan bentuk file ini:
 *
 * 1. **Tidak ada angka laporan yang disimpan di database.** Layer DB hanya
 *    mengambil baris mentah; seluruh matematika ada di sini. Akibatnya laporan
 *    tanggal berapa pun bisa dihitung ulang kapan pun, termasuk setelah bug
 *    perhitungan diperbaiki — tanpa migrasi data.
 *
 * 2. **Penyaringan status dilakukan DI SINI, bukan di query.** Transaksi
 *    VOIDED/CANCELLED/PENDING masuk sebagai input lalu dikecualikan oleh fungsi
 *    ini. Kalau penyaringan itu ditaruh di WHERE clause, aturan paling mudah
 *    salah di seluruh laporan justru menjadi satu-satunya bagian yang tidak
 *    bisa diuji tanpa database.
 */

export class ReportError extends MoneyError {}

// ─────────────────────────────── Bentuk baris mentah ───────────────────────────────

export interface ReportItemRow {
  productId: string
  productName: string
  qty: number
  /** Nominal yang benar-benar dibayar untuk baris ini, setelah semua diskon. */
  lineFinal: number
  unitCost: number
}

export interface ReportServiceRow {
  kind: string
  label: string
  direction: string
  providerName: string
  passthroughAmount: number
  serviceFeeAmount: number
  providerCostAmount: number
}

export interface ReportTransactionRow {
  id: string
  businessDate: string
  status: TransactionStatus
  /** Σ (unitPrice × qty) + Σ biaya admin jasa. OMZET. */
  grossSubtotal: number
  itemDiscountTotal: number
  transactionDiscount: number
  /** OMZET transaksi. Titipan jasa TIDAK ada di sini (docs/reporting.md §9). */
  netTotal: number
  cogsTotal: number
  /** BERTANDA. Titipan yang diteruskan ke provider; negatif untuk tarik tunai. */
  passthroughTotal: number
  /** Σ biaya admin. Bagian DARI netTotal. */
  serviceFeeTotal: number
  /** Metode pembayaran yang berstatus PAID. null kalau belum/tidak pernah lunas. */
  paidMethod: PaymentMethod | null
  items: ReportItemRow[]
  services: ReportServiceRow[]
}

export interface ReportRefundRow {
  id: string
  businessDate: string
  amount: number
  cogsAmount: number
  method: RefundMethod
}

export interface ReportExpenseRow {
  businessDate: string
  kategori: string
  amount: number
  paidFrom: ExpenseSource
}

export interface ReportShiftRow {
  cashierName: string
  status: ShiftStatus
  businessDate: string
  openedAt: Date
  closedAt: Date | null
  expectedCash: number | null
  countedCash: number | null
  difference: number | null
}

export interface ReportStockRow {
  productName: string
  stok: number
  stokMinimum: number
  satuan: string
}

export interface ReportInput {
  transactions: ReportTransactionRow[]
  refunds: ReportRefundRow[]
  expenses: ReportExpenseRow[]
  shifts: ReportShiftRow[]
  stock: ReportStockRow[]
  /**
   * Saldo provider SAAT INI, bukan saat periode laporan berakhir.
   *
   * Dibedakan dengan sengaja dari angka lain di laporan, yang semuanya bisa
   * dihitung ulang untuk tanggal apa pun. Saldo adalah keadaan sekarang, dan
   * laporan menampilkannya sebagai pengingat ("saldo Shopee tinggal 40 ribu"),
   * bukan sebagai angka historis. Kosong berarti toko belum memakai jasa.
   */
  providerBalances?: ProviderBalanceRow[]
}

// ─────────────────────────────── Bentuk hasil ───────────────────────────────

export interface MethodBreakdown {
  method: PaymentMethod
  count: number
  amount: number
}

export interface CategoryAmount {
  kategori: string
  amount: number
}

export interface TopProductQty {
  productName: string
  qty: number
  netSales: number
}

export interface TopProductProfit {
  productName: string
  grossProfit: number
  qty: number
}

export interface ServiceKindSummary {
  kind: string
  label: string
  count: number
  /** Σ titipan, selalu positif — volume uang yang lewat, bukan omzet. */
  passthrough: number
  /** Σ biaya admin. INI yang omzet. */
  fee: number
  /** Σ potongan provider. */
  providerCost: number
}

export interface ProviderBalanceRow {
  providerName: string
  saldo: number
}

export interface SalesAggregate {
  /** Σ unitPrice × qty, sebelum diskon apa pun. OMZET, bukan laba. */
  grossSales: number
  itemDiscounts: number
  transactionDiscounts: number
  discounts: number
  /** Gross Sales − Discounts. Tetap OMZET. */
  netSales: number
  /** Σ unitCost × qty, harga beli snapshot saat jual. */
  cogs: number
  /** Net Sales − COGS. Ini baru laba kotor. */
  grossProfit: number

  refunds: number
  refundedCogs: number
  netSalesAfterRefunds: number
  grossProfitAfterRefunds: number

  /** Hanya COMPLETED. VOIDED, CANCELLED, dan PENDING dikecualikan. */
  transactionCount: number
  itemCount: number
  /** null kalau tidak ada transaksi — bukan 0, bukan NaN. */
  averageTransaction: number | null

  byMethod: MethodBreakdown[]

  // ── JASA PEMBAYARAN ──
  //
  // Angka-angka ini SENGAJA berdiri sendiri dan tidak pernah dijumlahkan ke
  // grossSales atau netSales. Titipan adalah uang pelanggan yang cuma mampir di
  // laci sebelum diteruskan ke provider; menyebutnya omzet akan membuat pemilik
  // mengira tokonya beromzet puluhan juta dari uang yang bukan miliknya.
  //
  // Yang MASUK omzet hanya `serviceFees`, dan ia sudah termasuk di dalam
  // `netSales` — ditampilkan lagi di sini supaya bisa disebut terpisah, bukan
  // untuk dijumlahkan ulang.
  serviceFees: number
  /** Titipan yang diterima dari pelanggan (token, PLN, top-up, transfer). */
  passthroughOut: number
  /** Titipan yang masuk ke rekening toko lalu dibayar tunai (tarik tunai). */
  passthroughIn: number
  serviceCount: number
  servicesByKind: ServiceKindSummary[]
  /** Saldo provider saat laporan dibuat. Kosong kalau toko belum memakai jasa. */
  providerBalances: ProviderBalanceRow[]

  expenseTotal: number
  expenseFromCashDrawer: number
  expenseFromOther: number
  expensesByCategory: CategoryAmount[]

  shifts: ReportShiftRow[]
  cashDifferenceTotal: number

  topByQty: TopProductQty[]
  topByProfit: TopProductProfit[]

  voidCount: number
  refundCount: number
  cancelledCount: number

  stockAlerts: ReportStockRow[]
}

export interface AggregateOptions {
  /** Banyak baris di daftar produk terlaris. */
  topLimit?: number
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new ReportError(`${label} harus integer rupiah, dapat ${value}`)
  }
}

/**
 * Hitung seluruh angka laporan dari baris mentah.
 *
 * Yang dihitung dan yang TIDAK: tidak ada "laba bersih" di sini. Biaya di luar
 * HPP tidak tercatat lengkap (pajak, penyusutan, gaji yang tidak lewat modul
 * pengeluaran), jadi Gross Profit dan Total Pengeluaran ditampilkan
 * berdampingan tanpa diselisihkan lalu diberi nama yang tidak bisa
 * dipertanggungjawabkan (docs/reporting.md §1).
 */
export function aggregateSales(
  input: ReportInput,
  options: AggregateOptions = {},
): SalesAggregate {
  const topLimit = options.topLimit ?? 10

  let grossSales = 0
  let itemDiscounts = 0
  let transactionDiscounts = 0
  let netSales = 0
  let cogs = 0
  let transactionCount = 0
  let itemCount = 0
  let voidCount = 0
  let cancelledCount = 0

  let serviceFees = 0
  let passthroughOut = 0
  let passthroughIn = 0
  let serviceCount = 0

  const byMethod = new Map<PaymentMethod, { count: number; amount: number }>()
  const perServiceKind = new Map<string, ServiceKindSummary>()
  const perProduct = new Map<
    string,
    { productName: string; qty: number; netSales: number; cogs: number }
  >()

  for (const trx of input.transactions) {
    if (trx.status === 'VOIDED') {
      // Dicatat sebagai indikator pengawasan, TIDAK sebagai penjualan dan tidak
      // sebagai baris negatif. Secara ekonomi transaksi itu tidak pernah
      // terjadi — kasir salah input lalu membatalkannya (docs/reporting.md §2.1).
      voidCount++
      continue
    }
    if (trx.status === 'CANCELLED') {
      cancelledCount++
      continue
    }
    if (trx.status !== 'COMPLETED') continue

    assertInteger(trx.netTotal, 'netTotal')

    grossSales += trx.grossSubtotal
    itemDiscounts += trx.itemDiscountTotal
    transactionDiscounts += trx.transactionDiscount
    netSales += trx.netTotal
    cogs += trx.cogsTotal
    transactionCount++

    if (trx.paidMethod) {
      const entry = byMethod.get(trx.paidMethod) ?? { count: 0, amount: 0 }
      entry.count++
      // UANG YANG BERPINDAH, bukan omzet: `netTotal + passthroughTotal`.
      //
      // Rincian per metode bayar menjawab "berapa yang masuk laci dan berapa
      // yang masuk rekening", dan jawabannya harus bisa dicocokkan dengan
      // hitungan fisik laci. Memakai netTotal akan membuat angka tunai di
      // laporan lebih kecil daripada uang yang benar-benar ada, sebesar seluruh
      // titipan hari itu.
      entry.amount += trx.netTotal + trx.passthroughTotal
      byMethod.set(trx.paidMethod, entry)
    }

    serviceFees += trx.serviceFeeTotal

    for (const jasa of trx.services) {
      serviceCount++
      if (jasa.direction === 'PROVIDER_IN') passthroughIn += jasa.passthroughAmount
      else passthroughOut += jasa.passthroughAmount

      const acc = perServiceKind.get(jasa.kind) ?? {
        kind: jasa.kind,
        label: jasa.label,
        count: 0,
        passthrough: 0,
        fee: 0,
        providerCost: 0,
      }
      acc.count++
      acc.passthrough += jasa.passthroughAmount
      acc.fee += jasa.serviceFeeAmount
      acc.providerCost += jasa.providerCostAmount
      perServiceKind.set(jasa.kind, acc)
    }

    for (const item of trx.items) {
      itemCount += item.qty
      const key = item.productId
      const acc = perProduct.get(key) ?? {
        productName: item.productName,
        qty: 0,
        netSales: 0,
        cogs: 0,
      }
      acc.qty += item.qty
      acc.netSales += item.lineFinal
      acc.cogs += item.unitCost * item.qty
      perProduct.set(key, acc)
    }
  }

  const discounts = itemDiscounts + transactionDiscounts
  const grossProfit = netSales - cogs

  let refunds = 0
  let refundedCogs = 0
  for (const refund of input.refunds) {
    assertInteger(refund.amount, 'nominal refund')
    refunds += refund.amount
    refundedCogs += refund.cogsAmount
  }

  let expenseTotal = 0
  let expenseFromCashDrawer = 0
  let expenseFromOther = 0
  const categories = new Map<string, number>()
  for (const expense of input.expenses) {
    assertInteger(expense.amount, 'nominal pengeluaran')
    expenseTotal += expense.amount
    if (expense.paidFrom === 'CASH_DRAWER') expenseFromCashDrawer += expense.amount
    else expenseFromOther += expense.amount
    categories.set(expense.kategori, (categories.get(expense.kategori) ?? 0) + expense.amount)
  }

  const cashDifferenceTotal = input.shifts.reduce((sum, s) => sum + (s.difference ?? 0), 0)

  const products = [...perProduct.values()]

  // Dua daftar berbeda dengan sengaja: barang paling ramai sering bukan barang
  // paling menguntungkan, dan pemilik perlu melihat keduanya.
  const topByQty: TopProductQty[] = products
    .slice()
    .sort((a, b) => b.qty - a.qty || a.productName.localeCompare(b.productName))
    .slice(0, topLimit)
    .map((p) => ({ productName: p.productName, qty: p.qty, netSales: p.netSales }))

  const topByProfit: TopProductProfit[] = products
    .slice()
    .map((p) => ({ productName: p.productName, grossProfit: p.netSales - p.cogs, qty: p.qty }))
    .sort((a, b) => b.grossProfit - a.grossProfit || a.productName.localeCompare(b.productName))
    .slice(0, topLimit)

  return {
    grossSales,
    itemDiscounts,
    transactionDiscounts,
    discounts,
    netSales,
    cogs,
    grossProfit,

    refunds,
    refundedCogs,
    netSalesAfterRefunds: netSales - refunds,
    // Laba kotor hanya berkurang sebesar MARGIN yang dikembalikan: uangnya
    // keluar, tapi barangnya juga kembali (docs/reporting.md §2.2).
    grossProfitAfterRefunds: grossProfit - (refunds - refundedCogs),

    transactionCount,
    itemCount,
    // Pembagian dengan nol menghasilkan null, bukan 0 dan bukan NaN. Layer
    // tampilan menuliskannya sebagai "—".
    averageTransaction: transactionCount === 0 ? null : Math.round(netSales / transactionCount),

    byMethod: [...byMethod.entries()]
      .map(([method, v]) => ({ method, count: v.count, amount: v.amount }))
      .sort((a, b) => b.amount - a.amount),

    serviceFees,
    passthroughOut,
    passthroughIn,
    serviceCount,
    servicesByKind: [...perServiceKind.values()].sort(
      (a, b) => b.fee - a.fee || a.label.localeCompare(b.label),
    ),
    providerBalances: input.providerBalances ?? [],

    expenseTotal,
    expenseFromCashDrawer,
    expenseFromOther,
    expensesByCategory: [...categories.entries()]
      .map(([kategori, amount]) => ({ kategori, amount }))
      .sort((a, b) => b.amount - a.amount || a.kategori.localeCompare(b.kategori)),

    shifts: input.shifts,
    cashDifferenceTotal,

    topByQty,
    topByProfit,

    voidCount,
    refundCount: input.refunds.length,
    cancelledCount,

    stockAlerts: input.stock,
  }
}

// ─────────────────────────────── Perbandingan periode ───────────────────────────────

export interface Comparison {
  current: number
  previous: number
  delta: number
  /**
   * Persentase perubahan. `null` kalau periode sebelumnya 0 — bukan `Infinity`
   * dan bukan 100%. Naik dari nol tidak punya persentase yang bermakna.
   */
  percent: number | null
}

export function compareValue(current: number, previous: number): Comparison {
  const delta = current - previous
  return {
    current,
    previous,
    delta,
    percent: previous === 0 ? null : (delta / previous) * 100,
  }
}

export interface AggregateComparison {
  netSales: Comparison
  grossProfit: Comparison
  transactionCount: Comparison
  refunds: Comparison
}

export function compareAggregates(
  current: SalesAggregate,
  previous: SalesAggregate,
): AggregateComparison {
  return {
    netSales: compareValue(current.netSales, previous.netSales),
    grossProfit: compareValue(current.grossProfit, previous.grossProfit),
    transactionCount: compareValue(current.transactionCount, previous.transactionCount),
    refunds: compareValue(current.refunds, previous.refunds),
  }
}
