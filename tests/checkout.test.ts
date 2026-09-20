import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTransactionInTx,
  settleTransactionInTx,
  type CheckoutActor,
  type CheckoutInput,
} from '@/lib/checkout'

/**
 * Integration test checkout terhadap file SQLite sementara.
 *
 * Tiga hal yang diuji di sini menyangkut uang, dan tidak satu pun bisa
 * dibuktikan dengan membaca kode:
 *  1. dua checkout bersamaan atas produk sama → stok berkurang tepat 2,
 *  2. satu langkah gagal → tidak ada pembayaran tercatat tanpa stok berkurang,
 *  3. angka yang tersimpan cocok dengan fixture docs/reporting.md §3.1.
 */

let prisma: PrismaClient
let tmpDir: string
let dbPath: string

let cashierId: string
let shiftId: string

async function applyPragmas(client: PrismaClient): Promise<void> {
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON')
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL')
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000')
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-checkout-'))
  dbPath = path.join(tmpDir, 'test.db')

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: 'pipe',
    },
  )

  // connection_limit=1 sama seperti produksi. Tanpa ini, checkout bersamaan
  // saling rebutan write lock SQLite dan gagal semuanya — lihat architecture.md §6.2.
  prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbPath}?connection_limit=1` } },
  })
  await applyPragmas(prisma)

  const cashier = await prisma.user.create({
    data: { name: 'Kasir Budi', role: 'CASHIER', pinHash: 'x' },
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
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan; bukan kegagalan test.
  }
})

beforeEach(async () => {
  // Urutan hapus mengikuti arah foreign key.
  await prisma.stockMovement.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.transactionItem.deleteMany()
  await prisma.transaction.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.product.deleteMany()
  await prisma.dailyCounter.deleteMany()
})

async function makeProduct(opts: {
  sku: string
  nama?: string
  hargaJual: number
  hargaBeli: number
  stok: number
}) {
  return prisma.product.create({
    data: {
      sku: opts.sku,
      nama: opts.nama ?? opts.sku,
      searchKey: (opts.nama ?? opts.sku).toLowerCase(),
      kategori: 'Uji',
      hargaJual: opts.hargaJual,
      hargaBeli: opts.hargaBeli,
      stok: opts.stok,
      stokMinimum: 0,
    },
  })
}

function actorFor(): CheckoutActor {
  return { userId: cashierId, shiftId, role: 'CASHIER' }
}

let urutanKunci = 0
/**
 * UUID v4 uji yang selalu berbeda.
 *
 * `idempotencyKey` sekarang WAJIB pada `CheckoutInput`, dan kolomnya `@unique`.
 * Test di berkas ini menguji hal lain (race stok, rollback, pembulatan), jadi
 * kuncinya diisi otomatis — kecuali kalau test-nya memang ingin menentukan
 * sendiri, misalnya untuk menguji tabrakan.
 */
function kunciBaru(): string {
  urutanKunci += 1
  return `44444444-4444-4444-8444-${String(urutanKunci).padStart(12, '0')}`
}

/**
 * Isi keranjang tanpa kunci. Kuncinya diisi `runCheckout` per PEMANGGILAN,
 * bukan per objek — dua checkout bersamaan dalam test race adalah dua penjualan
 * berbeda (dua pelanggan), jadi keduanya memang harus punya kunci berbeda.
 */
type CheckoutFixture = Omit<CheckoutInput, 'idempotencyKey'> & { idempotencyKey?: string }

/** Checkout lengkap memakai client test (bukan singleton aplikasi). */
async function runCheckout(input: CheckoutFixture, now = new Date('2026-09-19T03:00:00Z')) {
  const lengkap: CheckoutInput = {
    ...input,
    idempotencyKey: input.idempotencyKey ?? kunciBaru(),
  }
  return prisma.$transaction(async (tx) => {
    const created = await createTransactionInTx(tx, lengkap, actorFor(), now)
    if (lengkap.method === 'CASH') {
      await settleTransactionInTx(tx, created.transactionId, actorFor(), now)
    }
    return created
  })
}

// ─────────────────────────── 1. Race dua kasir ───────────────────────────

describe('race: dua checkout bersamaan atas produk yang sama', () => {
  it('stok berkurang TEPAT 2 dan menghasilkan dua stock_movements', async () => {
    const product = await makeProduct({ sku: 'RACE-1', hargaJual: 10_000, hargaBeli: 7_000, stok: 10 })

    const line = { productId: product.id, qty: 1, itemDiscount: 0 }
    const input: CheckoutFixture = {
      lines: [line],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 10_000,
    }

    // Inilah bug yang dicegah: baca-lalu-tulis akan membuat keduanya membaca
    // stok 10, menghitung 9, dan menulis 9 — dua barang terjual tapi stok cuma
    // turun satu. Pengurangan atomic di SQL membuat itu mustahil.
    const results = await Promise.all([runCheckout(input), runCheckout(input)])

    expect(results).toHaveLength(2)
    expect(new Set(results.map((r) => r.trxNumber)).size).toBe(2)

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stok).toBe(8)

    const movements = await prisma.stockMovement.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(movements).toHaveLength(2)
    expect(movements.every((m) => m.reason === 'SALE')).toBe(true)
    expect(movements.every((m) => m.qtyChange === -1)).toBe(true)

    // stockBefore/stockAfter kedua baris harus membentuk rantai 10→9→8 tanpa
    // tumpang tindih. Kalau keduanya mencatat 10→9, lost update terjadi.
    const chain = movements.map((m) => [m.stockBefore, m.stockAfter]).sort((a, b) => b[0]! - a[0]!)
    expect(chain).toEqual([
      [10, 9],
      [9, 8],
    ])

    const completed = await prisma.transaction.count({ where: { status: 'COMPLETED' } })
    expect(completed).toBe(2)
    const paid = await prisma.payment.count({ where: { status: 'PAID' } })
    expect(paid).toBe(2)
  })

  it('lima checkout bersamaan mengurangi stok tepat lima', async () => {
    const product = await makeProduct({ sku: 'RACE-5', hargaJual: 5_000, hargaBeli: 3_000, stok: 20 })
    const input: CheckoutFixture = {
      lines: [{ productId: product.id, qty: 2, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 10_000,
    }

    await Promise.all(Array.from({ length: 5 }, () => runCheckout(input)))

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stok).toBe(20 - 5 * 2)

    const movements = await prisma.stockMovement.findMany({ where: { productId: product.id } })
    expect(movements).toHaveLength(5)
    expect(movements.reduce((s, m) => s + m.qtyChange, 0)).toBe(-10)

    // Invariant #10: stok == Σ qtyChange sepanjang riwayat.
    expect(after.stok).toBe(20 + movements.reduce((s, m) => s + m.qtyChange, 0))
  })

  it('nomor transaksi bersamaan tidak pernah bentrok', async () => {
    const product = await makeProduct({ sku: 'RACE-N', hargaJual: 1_000, hargaBeli: 500, stok: 100 })
    const input: CheckoutFixture = {
      lines: [{ productId: product.id, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 1_000,
    }

    const results = await Promise.all(Array.from({ length: 8 }, () => runCheckout(input)))
    const numbers = results.map((r) => r.trxNumber)

    expect(new Set(numbers).size).toBe(8)
    expect(numbers.every((n) => /^TRX-20260919-\d{6}$/.test(n))).toBe(true)

    // Urutannya rapat 1..8, tanpa lompatan.
    const seqs = numbers.map((n) => Number(n.split('-')[2])).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

// ─────────────────────────── 2. Rollback ───────────────────────────

describe('rollback: satu langkah gagal di tengah checkout', () => {
  it('gagal SETELAH pembayaran dibuat, SEBELUM stok dikurangi → tidak ada jejak apa pun', async () => {
    const product = await makeProduct({ sku: 'RB-1', hargaJual: 10_000, hargaBeli: 7_000, stok: 5 })

    await expect(
      prisma.$transaction(async (tx) => {
        await createTransactionInTx(
          tx,
          {
            lines: [{ productId: product.id, qty: 2, itemDiscount: 0 }],
            transactionDiscount: 0,
            idempotencyKey: kunciBaru(),
            method: 'CASH',
            amountTendered: 20_000,
          },
          actorFor(),
        )
        // Pada titik ini transaksi, item, dan PEMBAYARAN sudah tertulis di
        // dalam transaction, tapi stok belum berkurang. Inilah keadaan yang
        // tidak boleh pernah ter-commit.
        throw new Error('kegagalan buatan sebelum pengurangan stok')
      }),
    ).rejects.toThrow('kegagalan buatan sebelum pengurangan stok')

    expect(await prisma.payment.count()).toBe(0)
    expect(await prisma.transaction.count()).toBe(0)
    expect(await prisma.transactionItem.count()).toBe(0)
    expect(await prisma.stockMovement.count()).toBe(0)

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stok).toBe(5)
  })

  it('gagal SETELAH stok dikurangi → pengurangan stok ikut dibatalkan', async () => {
    const product = await makeProduct({ sku: 'RB-2', hargaJual: 10_000, hargaBeli: 7_000, stok: 5 })

    await expect(
      prisma.$transaction(async (tx) => {
        const created = await createTransactionInTx(
          tx,
          {
            lines: [{ productId: product.id, qty: 3, itemDiscount: 0 }],
            transactionDiscount: 0,
            idempotencyKey: kunciBaru(),
            method: 'CASH',
            amountTendered: 30_000,
          },
          actorFor(),
        )
        await settleTransactionInTx(tx, created.transactionId, actorFor())
        throw new Error('kegagalan buatan setelah pengurangan stok')
      }),
    ).rejects.toThrow('kegagalan buatan setelah pengurangan stok')

    expect(await prisma.payment.count()).toBe(0)
    expect(await prisma.stockMovement.count()).toBe(0)
    expect(await prisma.auditLog.count()).toBe(0)

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stok).toBe(5)
  })

  it('produk tidak ada → ditolak sebelum apa pun tertulis', async () => {
    await expect(
      runCheckout({
        lines: [{ productId: '00000000-0000-0000-0000-000000000000', qty: 1, itemDiscount: 0 }],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 10_000,
      }),
    ).rejects.toThrow()

    expect(await prisma.transaction.count()).toBe(0)
    expect(await prisma.payment.count()).toBe(0)
  })

  it('uang tunai kurang → ditolak, tidak ada transaksi setengah jadi', async () => {
    const product = await makeProduct({ sku: 'RB-3', hargaJual: 10_000, hargaBeli: 7_000, stok: 5 })

    await expect(
      runCheckout({
        lines: [{ productId: product.id, qty: 2, itemDiscount: 0 }],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 15_000,
      }),
    ).rejects.toThrow()

    expect(await prisma.transaction.count()).toBe(0)
    expect(await prisma.payment.count()).toBe(0)
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stok).toBe(5)
  })

  it('satu produk gagal di tengah keranjang multi-item → tidak ada yang berkurang', async () => {
    const ok = await makeProduct({ sku: 'RB-4A', hargaJual: 5_000, hargaBeli: 3_000, stok: 10 })
    const bad = { productId: '00000000-0000-0000-0000-000000000000', qty: 1, itemDiscount: 0 }

    await expect(
      runCheckout({
        lines: [{ productId: ok.id, qty: 1, itemDiscount: 0 }, bad],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 50_000,
      }),
    ).rejects.toThrow()

    const after = await prisma.product.findUniqueOrThrow({ where: { id: ok.id } })
    expect(after.stok).toBe(10)
    expect(await prisma.stockMovement.count()).toBe(0)
  })
})

// ─────────────────────────── 3. Angka tersimpan ───────────────────────────

describe('angka yang tersimpan cocok dengan fixture docs/reporting.md §3.1', () => {
  it('menulis alokasi diskon dan lineFinal persis seperti dokumen', async () => {
    const a = await makeProduct({ sku: 'FX-A', nama: 'Item A', hargaJual: 15_000, hargaBeli: 11_000, stok: 50 })
    const b = await makeProduct({ sku: 'FX-B', nama: 'Item B', hargaJual: 7_000, hargaBeli: 5_000, stok: 50 })
    const c = await makeProduct({ sku: 'FX-C', nama: 'Item C', hargaJual: 3_500, hargaBeli: 2_500, stok: 50 })

    const created = await runCheckout({
      lines: [
        { productId: a.id, qty: 2, itemDiscount: 0 },
        { productId: b.id, qty: 3, itemDiscount: 1_000 },
        { productId: c.id, qty: 1, itemDiscount: 0 },
      ],
      transactionDiscount: 5_000,
      method: 'CASH',
      amountTendered: 50_000,
    })

    const trx = await prisma.transaction.findUniqueOrThrow({
      where: { id: created.transactionId },
      include: { items: { orderBy: { sku: 'asc' } }, payments: true },
    })

    expect(trx.grossSubtotal).toBe(54_500)
    expect(trx.itemDiscountTotal).toBe(1_000)
    expect(trx.transactionDiscount).toBe(5_000)
    expect(trx.netTotal).toBe(48_500)
    expect(trx.cogsTotal).toBe(39_500)

    const [itemA, itemB, itemC] = trx.items
    expect(itemA?.allocatedTxDiscount).toBe(2_804)
    expect(itemB?.allocatedTxDiscount).toBe(1_869)
    expect(itemC?.allocatedTxDiscount).toBe(327)
    expect(itemA?.lineFinal).toBe(27_196)
    expect(itemB?.lineFinal).toBe(18_131)
    expect(itemC?.lineFinal).toBe(3_173)

    // Invariant #4 dan #5c di docs/database.md, diperiksa pada baris nyata.
    expect(trx.items.reduce((s, i) => s + i.allocatedTxDiscount, 0)).toBe(trx.transactionDiscount)
    expect(trx.items.reduce((s, i) => s + i.lineFinal, 0)).toBe(trx.netTotal)

    const payment = trx.payments[0]
    expect(payment?.status).toBe('PAID')
    expect(payment?.amount).toBe(48_500)
    expect(payment?.amountTendered).toBe(50_000)
    expect(payment?.changeAmount).toBe(1_500)
  })

  it('menyimpan snapshot harga, bukan referensi ke harga produk saat ini', async () => {
    const p = await makeProduct({ sku: 'SNAP-1', nama: 'Aqua', hargaJual: 4_000, hargaBeli: 2_800, stok: 20 })

    const created = await runCheckout({
      lines: [{ productId: p.id, qty: 2, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 10_000,
    })

    // Harga naik setelah transaksi terjadi.
    await prisma.product.update({
      where: { id: p.id },
      data: { hargaJual: 5_000, hargaBeli: 3_500, nama: 'Aqua Botol Baru' },
    })

    const item = await prisma.transactionItem.findFirstOrThrow({
      where: { transactionId: created.transactionId },
    })

    // Sejarah tidak ikut berubah — syarat mutlak HPP dan laba kotor yang benar.
    expect(item.unitPrice).toBe(4_000)
    expect(item.unitCost).toBe(2_800)
    expect(item.productName).toBe('Aqua')

    const trx = await prisma.transaction.findUniqueOrThrow({
      where: { id: created.transactionId },
    })
    expect(trx.cogsTotal).toBe(5_600)
  })
})

// ─────────────────────────── 4. Stok minus & QRIS ───────────────────────────

describe('stok minus diizinkan tapi tidak diam-diam', () => {
  it('checkout tetap berhasil dan melaporkan produk yang jadi negatif', async () => {
    const p = await makeProduct({ sku: 'NEG-1', nama: 'Gas LPG', hargaJual: 23_000, hargaBeli: 19_000, stok: 1 })

    const result = await prisma.$transaction(async (tx) => {
      const created = await createTransactionInTx(
        tx,
        {
          lines: [{ productId: p.id, qty: 3, itemDiscount: 0 }],
          transactionDiscount: 0,
          idempotencyKey: kunciBaru(),
          method: 'CASH',
          amountTendered: 100_000,
        },
        actorFor(),
      )
      return settleTransactionInTx(tx, created.transactionId, actorFor())
    })

    expect(result.negativeStock).toHaveLength(1)
    expect(result.negativeStock[0]?.productName).toBe('Gas LPG')
    expect(result.negativeStock[0]?.stockAfter).toBe(-2)

    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.stok).toBe(-2)

    // Jejaknya tetap lengkap dan bisa diperiksa.
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { productId: p.id } })
    expect(movement.stockBefore).toBe(1)
    expect(movement.stockAfter).toBe(-2)
  })
})

describe('QRIS statis tidak pernah lunas sendiri', () => {
  it('transaksi QRIS berhenti PENDING dan TIDAK menyentuh stok', async () => {
    const p = await makeProduct({ sku: 'QR-1', hargaJual: 10_000, hargaBeli: 7_000, stok: 5 })

    const created = await runCheckout({
      lines: [{ productId: p.id, qty: 2, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    })

    const trx = await prisma.transaction.findUniqueOrThrow({
      where: { id: created.transactionId },
      include: { payments: true },
    })
    expect(trx.status).toBe('PENDING')
    expect(trx.payments[0]?.status).toBe('PENDING')

    // Belum dibayar → stok belum boleh berkurang. Ini yang membuat transaksi
    // QRIS terlantar bisa dibatalkan tanpa perlu membalik stok.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.stok).toBe(5)
    expect(await prisma.stockMovement.count()).toBe(0)
  })

  it('konfirmasi kedua ditolak — double-confirm tidak menggandakan stok', async () => {
    const p = await makeProduct({ sku: 'QR-2', hargaJual: 10_000, hargaBeli: 7_000, stok: 5 })

    const created = await runCheckout({
      lines: [{ productId: p.id, qty: 2, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    })

    await prisma.$transaction(async (tx) => {
      await settleTransactionInTx(tx, created.transactionId, actorFor())
    })

    await expect(
      prisma.$transaction(async (tx) => {
        await settleTransactionInTx(tx, created.transactionId, actorFor())
      }),
    ).rejects.toThrow()

    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.stok).toBe(3)
    expect(await prisma.stockMovement.count()).toBe(1)
    expect(await prisma.payment.count({ where: { status: 'PAID' } })).toBe(1)
  })
})
