import type { Prisma } from '@prisma/client'
import { recordAudit, type AuditActor } from '../audit'
import { computeCart, type CartTotals, type CartLineInput, type PricedLine } from '../cart'
import { config } from '../config'
import { nextNumber } from '../db/counter'
import { prisma } from '../db/prisma'
import { applyStockMovement } from '../db/stock'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { assertCashSufficient, settlesImmediately } from '../payment'
import type { PaymentMethod } from '../enums'
import { toBusinessDate } from '../time'

/**
 * Checkout.
 *
 * Seluruh proses berjalan dalam SATU transaction database:
 *   buat transaksi → buat item → catat pembayaran → kurangi stok →
 *   catat audit log → commit
 *
 * Satu langkah gagal, semuanya di-rollback. Mustahil ada pembayaran tercatat
 * tapi stok tidak berkurang (docs/architecture.md §8).
 *
 * Dipecah menjadi dua fungsi ber-`tx` dengan sengaja:
 *  - createTransactionInTx : membuat transaksi PENDING, belum menyentuh stok
 *  - settleTransactionInTx : PENDING→PAID, kurangi stok, tandai COMPLETED
 *
 * Tunai memanggil keduanya berurutan di dalam transaction yang sama. QRIS
 * statis berhenti setelah yang pertama, lalu memanggil yang kedua nanti saat
 * kasir menekan konfirmasi. Keduanya bermuara ke settleTransactionInTx yang
 * sama, sehingga provider asli nanti tidak perlu mengubah kode transaksi.
 */

export interface CheckoutInput {
  lines: CartLineInput[]
  transactionDiscount: number
  method: PaymentMethod
  /** Wajib untuk tunai. */
  amountTendered?: number
  note?: string
}

export interface CheckoutActor extends AuditActor {
  userId: string
  shiftId: string
}

export interface NegativeStockWarning {
  productId: string
  productName: string
  stockAfter: number
}

export interface CheckoutResult {
  transactionId: string
  trxNumber: string
  status: string
  netTotal: number
  changeAmount: number | null
  /** Produk yang stoknya menjadi negatif setelah transaksi ini. */
  negativeStock: NegativeStockWarning[]
}

/**
 * Muat harga dan HPP dari DATABASE, bukan dari client.
 *
 * Client hanya mengirim productId, qty, dan diskon. Harga yang dikirim client
 * tidak pernah dipercaya — kalau dipercaya, siapa pun di LAN toko bisa membeli
 * barang seharga satu rupiah.
 */
async function priceLines(
  tx: Prisma.TransactionClient,
  lines: CartLineInput[],
): Promise<PricedLine[]> {
  if (lines.length === 0) throw new ValidationError('Keranjang kosong')

  const ids = [...new Set(lines.map((l) => l.productId))]
  const products = await tx.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, nama: true, sku: true, hargaJual: true, hargaBeli: true, aktif: true },
  })

  const byId = new Map(products.map((p) => [p.id, p]))

  return lines.map((line) => {
    const product = byId.get(line.productId)
    if (!product) throw new NotFoundError(`Produk tidak ditemukan: ${line.productId}`)
    if (!product.aktif) throw new ValidationError(`Produk sudah tidak aktif: ${product.nama}`)

    return {
      productId: product.id,
      productName: product.nama,
      sku: product.sku,
      unitPrice: product.hargaJual,
      unitCost: product.hargaBeli,
      qty: line.qty,
      itemDiscount: line.itemDiscount,
    }
  })
}

export interface CreatedTransaction {
  transactionId: string
  trxNumber: string
  paymentId: string
  totals: CartTotals
  changeAmount: number | null
}

/**
 * Tahap 1 — buat transaksi PENDING beserta item dan pembayarannya.
 *
 * TIDAK menyentuh stok. Transaksi QRIS yang ditinggalkan pelanggan karena itu
 * tidak meninggalkan efek samping apa pun, cukup dibatalkan (docs/qris.md §3.1).
 */
export async function createTransactionInTx(
  tx: Prisma.TransactionClient,
  input: CheckoutInput,
  actor: CheckoutActor,
  now: Date = new Date(),
): Promise<CreatedTransaction> {
  const businessDate = toBusinessDate(now, config.timezone)
  const priced = await priceLines(tx, input.lines)
  const totals = computeCart(priced, input.transactionDiscount)

  let amountTendered: number | null = null
  let changeAmount: number | null = null

  if (input.method === 'CASH') {
    if (input.amountTendered === undefined) {
      throw new ValidationError('Nominal uang yang diterima wajib diisi untuk pembayaran tunai')
    }
    const cash = assertCashSufficient(totals.netTotal, input.amountTendered)
    amountTendered = cash.amountTendered
    changeAmount = cash.changeAmount
  }

  const trxNumber = await nextNumber(tx, 'TRX', businessDate)

  const transaction = await tx.transaction.create({
    data: {
      trxNumber,
      businessDate,
      shiftId: actor.shiftId,
      cashierId: actor.userId,
      status: 'PENDING',
      grossSubtotal: totals.grossSubtotal,
      itemDiscountTotal: totals.itemDiscountTotal,
      transactionDiscount: totals.transactionDiscount,
      netTotal: totals.netTotal,
      cogsTotal: totals.cogsTotal,
      note: input.note ?? null,
      items: {
        create: totals.lines.map((line) => ({
          productId: line.productId,
          // Snapshot: perubahan harga besok tidak boleh menulis ulang sejarah.
          productName: line.productName,
          sku: line.sku,
          unitPrice: line.unitPrice,
          unitCost: line.unitCost,
          qty: line.qty,
          lineGross: line.lineGross,
          itemDiscount: line.itemDiscount,
          allocatedTxDiscount: line.allocatedTxDiscount,
          lineNet: line.lineNet,
          lineFinal: line.lineFinal,
        })),
      },
    },
  })

  const payment = await tx.payment.create({
    data: {
      transactionId: transaction.id,
      method: input.method,
      status: 'PENDING',
      amount: totals.netTotal,
      amountTendered,
      changeAmount,
      providerName: input.method === 'CASH' ? 'cash' : 'qris-static',
    },
  })

  return {
    transactionId: transaction.id,
    trxNumber,
    paymentId: payment.id,
    totals,
    changeAmount,
  }
}

export interface SettleResult {
  negativeStock: NegativeStockWarning[]
}

/**
 * Tahap 2 — lunaskan: PENDING→PAID, kurangi stok, tandai COMPLETED.
 *
 * Dipakai oleh tunai, QRIS statis, dan nanti provider dinamis. Satu-satunya
 * jalan sebuah transaksi menjadi COMPLETED dan stok berkurang.
 */
export async function settleTransactionInTx(
  tx: Prisma.TransactionClient,
  transactionId: string,
  actor: CheckoutActor,
  now: Date = new Date(),
): Promise<SettleResult> {
  const transaction = await tx.transaction.findUnique({
    where: { id: transactionId },
    include: { items: true, payments: true },
  })
  if (!transaction) throw new NotFoundError('Transaksi tidak ditemukan')
  if (transaction.status !== 'PENDING') {
    throw new ConflictError(`Transaksi sudah berstatus ${transaction.status}`)
  }

  const pending = transaction.payments.find((p) => p.status === 'PENDING')
  if (!pending) throw new ConflictError('Tidak ada pembayaran yang menunggu konfirmasi')

  // Gerbang transisi ada DI DATABASE, bukan hanya di kode. Dua kasir yang
  // menekan konfirmasi bersamaan sama-sama membaca PENDING dan sama-sama lolos
  // pengecekan di atas; hanya satu yang mendapat count === 1 di sini.
  const updated = await tx.payment.updateMany({
    where: { id: pending.id, status: 'PENDING' },
    data: { status: 'PAID', paidAt: now, confirmedByUserId: actor.userId },
  })
  if (updated.count !== 1) {
    throw new ConflictError('Pembayaran sudah diproses di perangkat lain')
  }

  const businessDate = toBusinessDate(now, config.timezone)
  const negativeStock: NegativeStockWarning[] = []

  for (const item of transaction.items) {
    const moved = await applyStockMovement(tx, {
      productId: item.productId,
      qtyChange: -item.qty,
      reason: 'SALE',
      refType: 'TRANSACTION',
      refId: transaction.id,
      userId: actor.userId,
      businessDate,
    })

    // Stok minus diizinkan — penjualan nyata lebih penting daripada angka stok
    // yang memang sering tidak akurat. Tapi ia tidak boleh lewat diam-diam.
    if (moved.stockAfter < 0) {
      negativeStock.push({
        productId: item.productId,
        productName: item.productName,
        stockAfter: moved.stockAfter,
      })
    }
  }

  await tx.transaction.update({
    where: { id: transaction.id },
    data: { status: 'COMPLETED', completedAt: now },
  })

  await recordAudit(tx, actor, {
    action: 'PAYMENT_CONFIRM',
    summary: `${transaction.trxNumber} lunas ${pending.method} ${transaction.netTotal}`,
    entityType: 'Transaction',
    entityId: transaction.id,
    after: {
      trxNumber: transaction.trxNumber,
      method: pending.method,
      netTotal: transaction.netTotal,
      negativeStock: negativeStock.map((n) => n.productName),
    },
  })

  return { negativeStock }
}

/**
 * Checkout lengkap.
 *
 * Tunai: buat + lunaskan dalam satu transaction database.
 * QRIS statis: berhenti di PENDING, menunggu konfirmasi manual kasir.
 */
export async function checkout(
  input: CheckoutInput,
  actor: CheckoutActor,
  now: Date = new Date(),
): Promise<CheckoutResult> {
  return prisma.$transaction(async (tx) => {
    const created = await createTransactionInTx(tx, input, actor, now)

    if (!settlesImmediately(input.method)) {
      return {
        transactionId: created.transactionId,
        trxNumber: created.trxNumber,
        status: 'PENDING',
        netTotal: created.totals.netTotal,
        changeAmount: null,
        negativeStock: [],
      }
    }

    const settled = await settleTransactionInTx(tx, created.transactionId, actor, now)

    return {
      transactionId: created.transactionId,
      trxNumber: created.trxNumber,
      status: 'COMPLETED',
      netTotal: created.totals.netTotal,
      changeAmount: created.changeAmount,
      negativeStock: settled.negativeStock,
    }
  })
}
