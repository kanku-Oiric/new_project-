import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTransactionInTx, type CheckoutActor } from '@/lib/checkout'
import {
  cancelPaymentInTx,
  confirmPaymentInTx,
  readPaymentStatus,
} from '@/lib/payment/service'

/**
 * Integration test QRIS statis terhadap file SQLite sementara.
 *
 * Yang diuji di sini tidak bisa dibuktikan dengan membaca kode:
 *  1. transaksi QRIS PENDING TIDAK menyentuh stok sama sekali,
 *  2. konfirmasi mengurangi stok tepat satu kali lewat jalur yang sama dengan
 *     tunai,
 *  3. konfirmasi kedua ditolak — berurutan maupun bersamaan dari dua koneksi,
 *  4. membaca status berkali-kali tidak pernah memajukan PENDING menjadi PAID,
 *  5. pembatalan tidak meninggalkan stok yang perlu dibalik.
 */

let prisma: PrismaClient
/** Koneksi kedua, untuk memaksa dua konfirmasi benar-benar bersamaan. */
let rival: PrismaClient
let tmpDir: string
let dbPath: string

let cashierId: string
let shiftId: string
let productId: string

const HARGA_JUAL = 12_500
const HARGA_BELI = 9_000
const STOK_AWAL = 40
const QTY = 3

async function applyPragmas(client: PrismaClient): Promise<void> {
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON')
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL')
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000')
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-qris-'))
  dbPath = path.join(tmpDir, 'test.db')

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbPath}?connection_limit=1` } },
  })
  rival = new PrismaClient({
    datasources: { db: { url: `file:${dbPath}?connection_limit=1` } },
  })
  await applyPragmas(prisma)
  await applyPragmas(rival)

  const cashier = await prisma.user.create({
    data: { name: 'Kasir QRIS', role: 'CASHIER', pinHash: 'x' },
  })
  cashierId = cashier.id

  const shift = await prisma.shift.create({
    data: {
      cashierId,
      status: 'OPEN',
      openKey: cashierId,
      openingCash: 0,
      businessDate: '2026-09-19',
    },
  })
  shiftId = shift.id
}, 120_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await rival?.$disconnect()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan; bukan kegagalan test.
  }
})

beforeEach(async () => {
  await prisma.stockMovement.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.transactionItem.deleteMany()
  await prisma.transaction.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.product.deleteMany()
  await prisma.dailyCounter.deleteMany()

  const product = await prisma.product.create({
    data: {
      sku: 'QRIS-001',
      nama: 'Minyak Goreng 1L',
      searchKey: 'minyak goreng 1l qris-001',
      kategori: 'Uji',
      hargaJual: HARGA_JUAL,
      hargaBeli: HARGA_BELI,
      stok: STOK_AWAL,
      stokMinimum: 5,
    },
  })
  productId = product.id
})

let urutanKunci = 0
/** UUID v4 uji yang selalu berbeda. */
function kunciBaru(): string {
  urutanKunci += 1
  const n = String(urutanKunci).padStart(12, '0')
  return `33333333-3333-4333-8333-${n}`
}

function actor(): CheckoutActor {
  return { userId: cashierId, shiftId, role: 'CASHIER' }
}

/** Buat transaksi QRIS yang berhenti di PENDING, seperti dilakukan route. */
async function createQrisTransaction(): Promise<{ transactionId: string; paymentId: string }> {
  const created = await prisma.$transaction((tx) =>
    createTransactionInTx(
      tx,
      {
        lines: [{ productId, qty: QTY, itemDiscount: 0 }],
        transactionDiscount: 0,
        method: 'QRIS_STATIC',
        // Kunci unik per pemanggilan: kolomnya @unique, dan dua transaksi uji
        // dengan kunci sama memang HARUS bertabrakan.
        idempotencyKey: kunciBaru(),
      },
      actor(),
    ),
  )
  return { transactionId: created.transactionId, paymentId: created.paymentId }
}

async function stokSekarang(): Promise<number> {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
  return p.stok
}

describe('QRIS PENDING belum menyentuh stok', () => {
  it('transaksi dibuat PENDING, stok utuh, tanpa stock_movement', async () => {
    const { transactionId, paymentId } = await createQrisTransaction()

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })

    expect(trx.status).toBe('PENDING')
    expect(payment.status).toBe('PENDING')
    expect(payment.method).toBe('QRIS_STATIC')
    expect(payment.providerName).toBe('qris-static')
    expect(payment.paidAt).toBeNull()
    expect(payment.confirmedByUserId).toBeNull()
    expect(payment.amount).toBe(HARGA_JUAL * QTY)

    // Inilah yang membuat transaksi terlantar aman dibatalkan tanpa membalik apa
    // pun (docs/qris.md §3.1).
    expect(await stokSekarang()).toBe(STOK_AWAL)
    expect(await prisma.stockMovement.count()).toBe(0)
  })

  it('membaca status berkali-kali tidak pernah melunaskan apa pun', async () => {
    const { transactionId, paymentId } = await createQrisTransaction()

    for (let i = 0; i < 20; i++) {
      const view = await readPaymentStatus(paymentId, prisma)
      expect(view.status).toBe('PENDING')
      expect(view.transactionStatus).toBe('PENDING')
      expect(view.providerName).toBe('qris-static')
      // `settlesOnCreate` sekarang true untuk QRIS soundbox: kasir menekan
      // tombolnya SETELAH kotaknya berbunyi, jadi checkout langsung melunaskan.
      //
      // Yang diuji di berkas ini justru jalur PENDING-nya, dan jalur itu TETAP
      // ADA: `createTransactionInTx` tidak pernah melunaskan apa pun sendiri —
      // yang memutuskan adalah `checkout()`. Provider dinamis nanti (Midtrans/
      // Xendit) memakai jalur yang sama persis lewat webhook, jadi seluruh
      // pemeriksaan di bawah ini menjaga kode yang masih akan dipakai.
      expect(view.settlesOnCreate).toBe(true)
    }

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(trx.status).toBe('PENDING')
    expect(await stokSekarang()).toBe(STOK_AWAL)
    expect(await prisma.stockMovement.count()).toBe(0)
  })
})

describe('konfirmasi manual', () => {
  it('melunaskan lewat jalur yang sama dengan tunai: stok, movement, audit', async () => {
    const { transactionId, paymentId } = await createQrisTransaction()

    const result = await prisma.$transaction((tx) =>
      confirmPaymentInTx(tx, paymentId, actor()),
    )
    expect(result.amount).toBe(HARGA_JUAL * QTY)
    expect(result.negativeStock).toEqual([])

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })

    expect(trx.status).toBe('COMPLETED')
    expect(trx.completedAt).not.toBeNull()
    expect(payment.status).toBe('PAID')
    expect(payment.paidAt).not.toBeNull()
    // Siapa yang mengonfirmasi tercatat. Ini syarat di docs/qris.md §3.2.
    expect(payment.confirmedByUserId).toBe(cashierId)

    expect(await stokSekarang()).toBe(STOK_AWAL - QTY)

    const movements = await prisma.stockMovement.findMany()
    expect(movements).toHaveLength(1)
    expect(movements[0]?.reason).toBe('SALE')
    expect(movements[0]?.qtyChange).toBe(-QTY)
    expect(movements[0]?.refId).toBe(transactionId)

    const audits = await prisma.auditLog.findMany({ where: { action: 'PAYMENT_CONFIRM' } })
    expect(audits).toHaveLength(1)
    expect(audits[0]?.userId).toBe(cashierId)
  })

  it('konfirmasi kedua berurutan ditolak, stok tidak berkurang dua kali', async () => {
    const { paymentId } = await createQrisTransaction()

    await prisma.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor()))

    await expect(
      prisma.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor())),
    ).rejects.toThrow(/sudah dikonfirmasi/i)

    expect(await stokSekarang()).toBe(STOK_AWAL - QTY)
    expect(await prisma.stockMovement.count()).toBe(1)
  })

  it('dua konfirmasi BERSAMAAN dari dua koneksi: tepat satu berhasil', async () => {
    const { transactionId, paymentId } = await createQrisTransaction()

    // Dua koneksi terpisah, bukan dua panggilan di koneksi yang sama — supaya
    // keduanya benar-benar berlomba, seperti dua kasir di dua HP menekan
    // "Pembayaran diterima" pada detik yang sama.
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor())),
      rival.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor())),
    ])

    const berhasil = results.filter((r) => r.status === 'fulfilled')
    expect(berhasil).toHaveLength(1)

    // Yang paling penting bukan pesan errornya, melainkan uang dan stoknya.
    const payments = await prisma.payment.findMany({ where: { id: paymentId } })
    expect(payments[0]?.status).toBe('PAID')

    expect(await stokSekarang()).toBe(STOK_AWAL - QTY)

    const movements = await prisma.stockMovement.findMany({ where: { refId: transactionId } })
    expect(movements).toHaveLength(1)

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(trx.status).toBe('COMPLETED')

    const audits = await prisma.auditLog.findMany({ where: { action: 'PAYMENT_CONFIRM' } })
    expect(audits).toHaveLength(1)
  }, 30_000)

  it('guarded update menolak baris yang sudah PAID', async () => {
    const { paymentId } = await createQrisTransaction()
    await prisma.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor()))

    // Lapis 2 dalam bentuk paling telanjang: syarat `status: 'PENDING'` di WHERE.
    // Ini menguji mekanismenya, bukan kode kita — dan memang itu maksudnya, sebab
    // seluruh jaminan "tidak pernah lunas dua kali" bertumpu pada perilaku ini.
    const guarded = await prisma.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: { status: 'PAID' },
    })
    expect(guarded.count).toBe(0)
  })
})

describe('pembatalan', () => {
  it('membatalkan yang PENDING: transaksi CANCELLED, tanpa stock_movement', async () => {
    const { transactionId, paymentId } = await createQrisTransaction()

    const result = await prisma.$transaction((tx) =>
      cancelPaymentInTx(tx, paymentId, { userId: cashierId, role: 'CASHIER' }, 'Pelanggan batal'),
    )
    expect(result.transactionCancelled).toBe(true)

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })

    expect(trx.status).toBe('CANCELLED')
    expect(trx.cancelReason).toBe('Pelanggan batal')
    expect(payment.status).toBe('CANCELLED')
    expect(payment.failureReason).toBe('Pelanggan batal')

    // Tidak ada stok yang perlu dibalik karena tidak ada yang pernah berkurang.
    expect(await stokSekarang()).toBe(STOK_AWAL)
    expect(await prisma.stockMovement.count()).toBe(0)

    const audits = await prisma.auditLog.findMany({ where: { action: 'PAYMENT_CANCEL' } })
    expect(audits).toHaveLength(1)
  })

  it('konfirmasi setelah dibatalkan ditolak — transaksi mati tidak bisa dihidupkan', async () => {
    const { paymentId } = await createQrisTransaction()
    await prisma.$transaction((tx) =>
      cancelPaymentInTx(tx, paymentId, { userId: cashierId, role: 'CASHIER' }, 'Batal'),
    )

    await expect(
      prisma.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor())),
    ).rejects.toThrow(/sudah dibatalkan/i)

    expect(await stokSekarang()).toBe(STOK_AWAL)
    expect(await prisma.stockMovement.count()).toBe(0)
  })

  it('membatalkan yang sudah lunas ditolak — gunakan void atau refund', async () => {
    const { paymentId } = await createQrisTransaction()
    await prisma.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor()))

    await expect(
      prisma.$transaction((tx) =>
        cancelPaymentInTx(tx, paymentId, { userId: cashierId, role: 'CASHIER' }, 'Salah tekan'),
      ),
    ).rejects.toThrow(/void atau refund/i)

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.status).toBe('PAID')
    expect(await stokSekarang()).toBe(STOK_AWAL - QTY)
  })

  it('pembatalan kedua ditolak, tanpa menulis apa pun lagi', async () => {
    const { paymentId } = await createQrisTransaction()
    await prisma.$transaction((tx) =>
      cancelPaymentInTx(tx, paymentId, { userId: cashierId, role: 'CASHIER' }, 'Batal'),
    )

    await expect(
      prisma.$transaction((tx) =>
        cancelPaymentInTx(tx, paymentId, { userId: cashierId, role: 'CASHIER' }, 'Batal lagi'),
      ),
    ).rejects.toThrow(/sudah dibatalkan/i)

    const audits = await prisma.auditLog.findMany({ where: { action: 'PAYMENT_CANCEL' } })
    expect(audits).toHaveLength(1)
  })
})

describe('pembayaran yang tidak ada', () => {
  it('konfirmasi id asing → tidak ditemukan, bukan membuat apa pun', async () => {
    await expect(
      prisma.$transaction((tx) =>
        confirmPaymentInTx(tx, '00000000-0000-0000-0000-000000000000', actor()),
      ),
    ).rejects.toThrow(/tidak ditemukan/i)

    expect(await prisma.payment.count()).toBe(0)
    expect(await prisma.transaction.count()).toBe(0)
  })
})
