import type { Prisma } from '@prisma/client'
import { recordAudit, type AuditActor } from '../audit'
import { computeCart, type CartTotals, type CartLineInput, type PricedLine } from '../cart'
import { config } from '../config'
import { nextNumber } from '../db/counter'
import { prisma } from '../db/prisma'
import { applyStockMovement } from '../db/stock'
import { isUniqueViolation } from '../db/errors'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { canonicalJson } from '../idempotency'
import { fingerprint } from '../idempotency-server'
import { assertCashSufficient, canTransition, settlesImmediately } from '../payment'
import { providerForMethod } from '../payment/registry'
import type { PaymentMethod, PaymentStatus } from '../enums'
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
  /**
   * Kunci sekali-pakai dari layar kasir (lihat src/lib/idempotency.ts).
   *
   * WAJIB. Dulu opsional, dan itu berarti perlindungan terhadap pengulangan
   * bergantung pada kedisiplinan client: bundel JS lama yang masih ter-cache di
   * HP kasir, client yang dimodifikasi, atau `curl` mendapat perilaku lama
   * secara senyap — dan sistem tidak pernah tahu perlindungannya tidak aktif.
   */
  idempotencyKey: string
}

/**
 * Yang dibutuhkan untuk MELUNASKAN. Sengaja lebih sempit daripada
 * `CheckoutActor`: konfirmasi QRIS datang lewat request tersendiri yang tidak
 * membuat transaksi baru, jadi ia tidak perlu tahu shift mana pun — transaksinya
 * sudah terikat ke shift saat dibuat.
 */
export interface SettleActor extends AuditActor {
  userId: string
}

export interface CheckoutActor extends SettleActor {
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
  /** Dibutuhkan layar kasir untuk mengonfirmasi/membatalkan pembayaran QRIS. */
  paymentId: string
  status: string
  netTotal: number
  changeAmount: number | null
  /** Produk yang stoknya menjadi negatif setelah transaksi ini. */
  negativeStock: NegativeStockWarning[]
  /**
   * `true` berarti request ini TIDAK membuat transaksi baru: kuncinya sudah
   * pernah dipakai, dan yang dikembalikan adalah transaksi yang sudah tersimpan.
   * Layar kasir memakainya untuk mengatakan "sudah tersimpan sebelumnya" alih-alih
   * membiarkan kasir menyangka ada penjualan kedua.
   */
  replayed: boolean
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
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: checkoutFingerprint(input),
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
      // Nama provider diambil dari registry, bukan ditulis literal, supaya
      // tidak ada baris pembayaran yang mengaku dilayani provider yang tidak
      // terdaftar (docs/qris.md §5).
      providerName: providerForMethod(input.method).name,
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
  actor: SettleActor,
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

  // LAPIS 1 — fungsi murni `canTransition` yang MEMILIH baris mana yang boleh
  // dilunaskan, bukan sekadar mengiyakan pilihan yang sudah diambil. Status yang
  // dinilai adalah status TERSIMPAN di database (docs/qris.md §4).
  const pending = transaction.payments.find((p) =>
    canTransition(p.status as PaymentStatus, 'PAID'),
  )
  if (!pending) {
    const statuses = transaction.payments.map((p) => p.status).join(', ') || 'tidak ada'
    throw new ConflictError(`Tidak ada pembayaran yang bisa dilunaskan (status: ${statuses})`)
  }

  // LAPIS 2 — gerbangnya ada DI DATABASE, bukan hanya di kode. Dua kasir yang
  // menekan konfirmasi bersamaan sama-sama membaca PENDING dan sama-sama lolos
  // lapis 1; hanya satu yang mendapat count === 1 di sini.
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
 * Sidik jari isi checkout.
 *
 * Hanya field yang MENENTUKAN penjualannya yang ikut. Aktor sengaja tidak ikut:
 * kalau response hilang lalu shift ditutup dan dibuka lagi, pengulangan harus
 * tetap mengembalikan transaksi yang sama — penjualannya memang sudah terjadi di
 * shift yang lama, dan memindahkannya akan merusak rekonsiliasi kas.
 *
 * Urutan baris tidak ikut menentukan: keranjang yang sama dengan urutan berbeda
 * adalah penjualan yang sama, dan menolaknya hanya akan membingungkan kasir.
 *
 * Client TIDAK perlu menghitung angka yang sama. Ia hanya memakai `canonicalJson`
 * untuk tahu kapan isi keranjang berubah sehingga kunci baru harus dibuat.
 */
function checkoutFingerprint(input: CheckoutInput): string {
  return fingerprint({
    lines: input.lines
      .map((l) => canonicalJson({ productId: l.productId, qty: l.qty, itemDiscount: l.itemDiscount }))
      .sort(),
    transactionDiscount: input.transactionDiscount,
    method: input.method,
    amountTendered: input.amountTendered ?? null,
    note: input.note ?? null,
  })
}

/**
 * Baca hasil transaksi yang kuncinya sudah pernah dipakai.
 *
 * `null` berarti kuncinya belum pernah dipakai — bukan berarti tidak ada masalah
 * lain. Pemanggilnya yang memutuskan apa artinya.
 *
 * Dua penolakan di sini, keduanya 409 dan keduanya sengaja TIDAK dijawab dengan
 * data transaksi:
 *  - sidik jari berbeda: kunci yang sama dipakai untuk keranjang lain. Menjawabnya
 *    berarti kasir menerima struk penjualan yang salah tanpa pernah tahu.
 *  - kasir berbeda: kunci milik orang lain. Menjawabnya membocorkan transaksi
 *    kasir lain ke siapa pun di LAN yang bisa menebak kuncinya.
 */
async function readCheckoutByKey(
  key: string,
  expectedFingerprint: string,
  actor: CheckoutActor,
): Promise<CheckoutResult | null> {
  const trx = await prisma.transaction.findUnique({
    where: { idempotencyKey: key },
    include: {
      items: { select: { productId: true, productName: true } },
      payments: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!trx) return null

  if (trx.idempotencyFingerprint !== expectedFingerprint) {
    throw new ConflictError(
      'Kunci transaksi ini sudah dipakai untuk keranjang yang berbeda. Muat ulang layar kasir sebelum mengulang.',
    )
  }
  if (trx.cashierId !== actor.userId) {
    throw new ConflictError('Kunci transaksi ini milik kasir lain.')
  }

  // Yang PENDING diutamakan: untuk QRIS, layar kasir butuh justru baris itu
  // supaya tombol konfirmasi dan batal tetap bekerja setelah pengulangan.
  const payment = trx.payments.find((p) => p.status === 'PENDING') ?? trx.payments.at(-1) ?? null

  // Peringatan stok minus dibaca ULANG dari stock_movements, bukan dihitung dari
  // stok sekarang. Angka di movement adalah stok pada saat penjualan itu terjadi,
  // dan itulah yang seharusnya dibaca kasir — stok hari ini sudah bergerak.
  const movements = await prisma.stockMovement.findMany({
    where: { refType: 'TRANSACTION', refId: trx.id, reason: 'SALE' },
    select: { productId: true, stockAfter: true },
  })
  const nameOf = new Map(trx.items.map((i) => [i.productId, i.productName]))

  return {
    transactionId: trx.id,
    trxNumber: trx.trxNumber,
    paymentId: payment?.id ?? '',
    status: trx.status,
    netTotal: trx.netTotal,
    changeAmount: payment?.changeAmount ?? null,
    negativeStock: movements
      .filter((m) => m.stockAfter < 0)
      .map((m) => ({
        productId: m.productId,
        productName: nameOf.get(m.productId) ?? 'Produk',
        stockAfter: m.stockAfter,
      })),
    replayed: true,
  }
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
  // Metode yang providernya belum siap ditolak SEBELUM transaksi dibuat. Kalau
  // tidak, kasir mendapat transaksi PENDING yang tidak akan pernah bisa dibayar
  // karena gambar QR-nya memang belum ada.
  //
  // Statusnya 400, bukan 503: tidak ada yang tertulis ke database, dan tindakan
  // yang benar bagi kasir adalah beralih ke tunai — bukan "periksa riwayat
  // sebelum mengulang" seperti yang ditampilkan UI untuk kegagalan server.
  const readiness = await providerForMethod(input.method).describe()
  if (!readiness.configured) {
    throw new ValidationError(
      [readiness.label, readiness.hint].filter(Boolean).join('. '),
    )
  }

  // Lapis kedua penegakan, setelah Zod di route. Service ini dipanggil juga dari
  // kode lain nanti (webhook provider dinamis, misalnya), dan invariannya tidak
  // boleh bergantung pada satu route saja.
  const key = input.idempotencyKey
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ValidationError('idempotencyKey wajib diisi untuk membuat transaksi')
  }
  const print = checkoutFingerprint(input)

  // Jalur cepat: pengulangan yang kuncinya sudah tercatat tidak menyentuh logika
  // checkout sama sekali, jadi tidak ada nomor transaksi yang terbakar dan tidak
  // ada stok yang bergerak dua kali.
  const replayed = await readCheckoutByKey(key, print, actor)
  if (replayed) return replayed

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await createTransactionInTx(tx, input, actor, now)

      if (!settlesImmediately(input.method)) {
        return {
          transactionId: created.transactionId,
          trxNumber: created.trxNumber,
          paymentId: created.paymentId,
          status: 'PENDING',
          netTotal: created.totals.netTotal,
          changeAmount: null,
          negativeStock: [],
          replayed: false,
        }
      }

      const settled = await settleTransactionInTx(tx, created.transactionId, actor, now)

      return {
        transactionId: created.transactionId,
        trxNumber: created.trxNumber,
        paymentId: created.paymentId,
        status: 'COMPLETED',
        netTotal: created.totals.netTotal,
        changeAmount: created.changeAmount,
        negativeStock: settled.negativeStock,
        replayed: false,
      }
    })
  } catch (e) {
    // Dua request serentak dengan kunci yang sama: keduanya lolos jalur cepat di
    // atas, lalu indeks unique di DATABASE yang memutuskan siapa menang. Yang
    // kalah membaca hasil pemenang — bukan melempar error ke kasir.
    //
    // Kalau P2002-nya datang dari kolom lain (misalnya trxNumber yang bentrok),
    // pembacaan ini mengembalikan null dan errornya diteruskan apa adanya.
    if (isUniqueViolation(e)) {
      const replayed = await readCheckoutByKey(key, print, actor)
      if (replayed) return replayed
    }
    throw e
  }
}
