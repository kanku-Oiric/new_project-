import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Void terhadap SQLite sungguhan: transisi `PAID → CANCELLED` harus lewat state
 * machine resmi, dan tidak boleh ada mutasi langsung yang melewatinya.
 *
 * Temuan audit yang ditutup berkas ini:
 *
 *   voidTransaction() dulu menjalankan
 *     tx.payment.updateMany({ where: { transactionId }, data: { status: 'CANCELLED' } })
 *   tanpa filter status dan tanpa pernah menanyakan `canTransition`. Akibatnya
 *   invarian "state terminal tidak punya transisi keluar" ditegakkan untuk semua
 *   jalur KECUALI satu-satunya jalur yang benar-benar melanggarnya — dan
 *   pembayaran yang sudah EXPIRED pun ikut ditimpa menjadi CANCELLED.
 */

let prisma: PrismaClient
let tmpDir = ''
let voidTransaction: typeof import('@/lib/transaction/service').voidTransaction
let ownerId = ''
let cashierId = ''
let shiftId = ''
let productId = ''

const NOW = new Date('2026-09-20T05:00:00Z') // 12:00 WIB
const BUSINESS_DATE = '2026-09-20'

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-void-'))
  const dbPath = path.join(tmpDir, 'void.db')

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, stdio: 'pipe' },
  )

  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups')

  const svc = await import('@/lib/transaction/service')
  voidTransaction = svc.voidTransaction
  const db = await import('@/lib/db/prisma')
  prisma = db.prisma

  const owner = await prisma.user.create({
    data: { name: 'Pemilik Void', role: 'OWNER', pinHash: 'x' },
  })
  ownerId = owner.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir Void', role: 'CASHIER', pinHash: 'x' },
  })
  cashierId = cashier.id

  const shift = await prisma.shift.create({
    data: {
      cashierId,
      status: 'OPEN',
      openKey: cashierId,
      openingCash: 0,
      businessDate: BUSINESS_DATE,
      openedAt: NOW,
    },
  })
  shiftId = shift.id

  const product = await prisma.product.create({
    data: {
      sku: 'VOID-1',
      nama: 'Produk Void',
      searchKey: 'produk void',
      kategori: 'Uji',
      hargaJual: 10_000,
      hargaBeli: 6_000,
      stok: 100,
      stokMinimum: 5,
    },
  })
  productId = product.id
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan.
  }
})

beforeEach(async () => {
  await prisma.auditLog.deleteMany()
  await prisma.stockMovement.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.transactionItem.deleteMany()
  await prisma.transaction.deleteMany()
  await prisma.product.update({ where: { id: productId }, data: { stok: 100 } })
})

/** Transaksi lunas dengan satu pembayaran berstatus `status`. */
async function buatTransaksi(
  status: 'PAID' | 'PENDING' | 'EXPIRED',
  method: 'CASH' | 'QRIS_STATIC' = 'QRIS_STATIC',
): Promise<{ transactionId: string; paymentId: string }> {
  const trx = await prisma.transaction.create({
    data: {
      trxNumber: `TRX-20260920-${String(Date.now() % 1_000_000).padStart(6, '0')}`,
      businessDate: BUSINESS_DATE,
      shiftId,
      cashierId,
      status: status === 'PAID' ? 'COMPLETED' : 'PENDING',
      completedAt: status === 'PAID' ? NOW : null,
      grossSubtotal: 20_000,
      itemDiscountTotal: 0,
      transactionDiscount: 0,
      netTotal: 20_000,
      cogsTotal: 12_000,
      idempotencyKey: `void-${Math.random().toString(16).slice(2)}`,
      idempotencyFingerprint: 'uji',
      items: {
        create: [
          {
            productId,
            productName: 'Produk Void',
            sku: 'VOID-1',
            unitPrice: 10_000,
            unitCost: 6_000,
            qty: 2,
            lineGross: 20_000,
            itemDiscount: 0,
            allocatedTxDiscount: 0,
            lineNet: 20_000,
            lineFinal: 20_000,
          },
        ],
      },
    },
  })

  const payment = await prisma.payment.create({
    data: {
      transactionId: trx.id,
      method,
      status,
      amount: 20_000,
      providerName: method === 'CASH' ? 'cash' : 'qris-static',
      paidAt: status === 'PAID' ? NOW : null,
      confirmedByUserId: status === 'PAID' ? cashierId : null,
    },
  })

  if (status === 'PAID') {
    await prisma.product.update({ where: { id: productId }, data: { stok: { decrement: 2 } } })
  }

  return { transactionId: trx.id, paymentId: payment.id }
}

function actor() {
  return { userId: cashierId, role: 'CASHIER' as const, authorizedByUserId: ownerId }
}

describe('void atas QRIS yang sudah PAID', () => {
  it('pembayaran menjadi CANCELLED lewat transisi resmi, dan stok kembali', async () => {
    const { transactionId, paymentId } = await buatTransaksi('PAID')
    const stokSebelum = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok

    const hasil = await voidTransaction(actor(), transactionId, 'Pelanggan batal', NOW)

    expect(hasil.needsManualRefund).toBe(true)

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.status).toBe('CANCELLED')
    expect(payment.failureReason).toContain('Void:')

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(trx.status).toBe('VOIDED')

    const stokSesudah = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok
    expect(stokSesudah).toBe(stokSebelum + 2)
  }, 60_000)

  it('paidAt dan confirmedByUserId TIDAK dihapus', async () => {
    // Inilah satu-satunya bukti tersisa bahwa uangnya pernah masuk. Dashboard
    // kewajiban manual membacanya justru karena status-nya sudah ditimpa
    // CANCELLED oleh void.
    const { transactionId, paymentId } = await buatTransaksi('PAID')
    await voidTransaction(actor(), transactionId, 'Pelanggan batal', NOW)

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.paidAt).not.toBeNull()
    expect(payment.confirmedByUserId).toBe(cashierId)
  }, 60_000)

  it('tercatat di audit log dengan pemberi otorisasi', async () => {
    const { transactionId } = await buatTransaksi('PAID')
    await voidTransaction(actor(), transactionId, 'Pelanggan batal', NOW)

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'VOID' } })
    expect(audit.entityId).toBe(transactionId)
    expect(String(audit.afterJson)).toContain('"manualRefundRequired":true')
  }, 60_000)

  it('void KEDUA ditolak — tidak ada stok yang kembali dua kali', async () => {
    const { transactionId } = await buatTransaksi('PAID')
    await voidTransaction(actor(), transactionId, 'Pelanggan batal', NOW)
    const stokSetelahVoid = (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .stok

    await expect(
      voidTransaction(actor(), transactionId, 'Coba lagi', NOW),
    ).rejects.toThrow(/sudah dibatalkan/i)

    const stokAkhir = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok
    expect(stokAkhir).toBe(stokSetelahVoid)
    expect(await prisma.stockMovement.count({ where: { reason: 'VOID' } })).toBe(1)
  }, 60_000)

  it('dua void SERENTAK: hanya satu yang berhasil', async () => {
    const { transactionId } = await buatTransaksi('PAID')
    const stokSebelum = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok

    const hasil = await Promise.allSettled([
      voidTransaction(actor(), transactionId, 'Serentak A', NOW),
      voidTransaction(actor(), transactionId, 'Serentak B', NOW),
    ])

    const berhasil = hasil.filter((h) => h.status === 'fulfilled')
    expect(berhasil).toHaveLength(1)

    const stokSesudah = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok
    expect(stokSesudah).toBe(stokSebelum + 2)
    expect(await prisma.stockMovement.count({ where: { reason: 'VOID' } })).toBe(1)
  }, 60_000)
})

describe('void tidak menulis ulang pembayaran yang sudah selesai dengan cara lain', () => {
  it('pembayaran EXPIRED TIDAK ikut ditimpa menjadi CANCELLED', async () => {
    // Perilaku LAMA: updateMany tanpa filter status menimpa semua baris, jadi
    // EXPIRED pun menjadi CANCELLED dan alasan aslinya hilang. `canTransition`
    // menolak EXPIRED → CANCELLED bahkan lewat void, jadi barisnya kini
    // dilewati.
    const trx = await prisma.transaction.create({
      data: {
        trxNumber: 'TRX-20260920-999001',
        businessDate: BUSINESS_DATE,
        shiftId,
        cashierId,
        status: 'COMPLETED',
        completedAt: NOW,
        grossSubtotal: 20_000,
        itemDiscountTotal: 0,
        transactionDiscount: 0,
        netTotal: 20_000,
        cogsTotal: 12_000,
        items: {
          create: [
            {
              productId,
              productName: 'Produk Void',
              sku: 'VOID-1',
              unitPrice: 10_000,
              unitCost: 6_000,
              qty: 2,
              lineGross: 20_000,
              itemDiscount: 0,
              allocatedTxDiscount: 0,
              lineNet: 20_000,
              lineFinal: 20_000,
            },
          ],
        },
      },
    })

    const kedaluwarsa = await prisma.payment.create({
      data: {
        transactionId: trx.id,
        method: 'QRIS_STATIC',
        status: 'EXPIRED',
        amount: 20_000,
        providerName: 'qris-static',
        failureReason: 'Kedaluwarsa sebelum dibayar',
      },
    })
    const lunas = await prisma.payment.create({
      data: {
        transactionId: trx.id,
        method: 'CASH',
        status: 'PAID',
        amount: 20_000,
        providerName: 'cash',
        paidAt: NOW,
      },
    })

    await voidTransaction(actor(), trx.id, 'Void dengan dua pembayaran', NOW)

    const setelahExpired = await prisma.payment.findUniqueOrThrow({ where: { id: kedaluwarsa.id } })
    expect(setelahExpired.status).toBe('EXPIRED')
    expect(setelahExpired.failureReason).toBe('Kedaluwarsa sebelum dibayar')

    const setelahLunas = await prisma.payment.findUniqueOrThrow({ where: { id: lunas.id } })
    expect(setelahLunas.status).toBe('CANCELLED')
  }, 60_000)

  it('pembayaran PENDING ikut dibatalkan (transisi normal)', async () => {
    const { transactionId, paymentId } = await buatTransaksi('PENDING')
    // Transaksi PENDING tidak bisa di-void; jadikan COMPLETED dulu supaya yang
    // diuji memang perilaku terhadap baris pembayarannya.
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { status: 'COMPLETED', completedAt: NOW },
    })

    await voidTransaction(actor(), transactionId, 'Void', NOW)

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.status).toBe('CANCELLED')
    expect(payment.paidAt).toBeNull()
  }, 60_000)
})
