import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { NotificationProvider, ReportMessage } from '@/lib/notify/types'
import { SendError } from '@/lib/notify/types'
import { catchUpReports, deliverReport } from '@/lib/report/service'

/**
 * Catch-up laporan terhadap SQLite sementara, dengan jam palsu dan provider
 * palsu.
 *
 * Skenario utamanya "server mati 3 hari" (docs/reporting.md §7.2). Laptop toko
 * dimatikan tiap malam, jadi ini bukan kasus tepi — ini keadaan normal, dan
 * satu-satunya cara menguji perilakunya tanpa menunggu tiga hari sungguhan
 * adalah dengan menyuntikkan `now`.
 */

let prisma: PrismaClient
let tmpDir: string
let cashierId: string
let shiftId: string
let productId: string

/** Provider palsu: mencatat apa yang dikirim, tidak menyentuh jaringan. */
function fakeProvider(options: { fail?: SendError } = {}): {
  provider: NotificationProvider
  sent: ReportMessage[]
} {
  const sent: ReportMessage[] = []
  const provider: NotificationProvider = {
    channel: 'DISCORD',
    name: 'uji',
    isConfigured: async () => true,
    describe: async () => ({ configured: true, label: 'uji', hint: null }),
    send: async (message) => {
      if (options.fail) throw options.fail
      sent.push(message)
    },
  }
  return { provider, sent }
}

const noSleep = async (): Promise<void> => undefined
const noRetry = { sleep: noSleep, random: () => 0, maxAttempts: 1 }

function catchUpOptions(provider: NotificationProvider) {
  return {
    db: prisma,
    channels: ['DISCORD' as const],
    kinds: ['DAILY' as const],
    providerFor: () => provider,
    sendOptions: noRetry,
    sleep: noSleep,
    betweenSendsMs: 0,
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-catchup-'))
  const dbPath = path.join(tmpDir, 'test.db')

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}?connection_limit=1` } } })

  const cashier = await prisma.user.create({
    data: { name: 'Kasir Laporan', role: 'CASHIER', pinHash: 'x' },
  })
  cashierId = cashier.id

  const shift = await prisma.shift.create({
    data: {
      cashierId,
      status: 'CLOSED',
      openingCash: 0,
      businessDate: '2026-09-15',
      countedCash: 0,
      expectedCash: 0,
      difference: 0,
      closedAt: new Date('2026-09-15T15:00:00Z'),
    },
  })
  shiftId = shift.id

  const product = await prisma.product.create({
    data: {
      sku: 'LAP-001',
      nama: 'Kopi Sachet',
      searchKey: 'kopi sachet lap-001',
      kategori: 'Minuman',
      hargaJual: 2_000,
      hargaBeli: 1_400,
      stok: 500,
      stokMinimum: 10,
    },
  })
  productId = product.id
}, 120_000)

afterAll(async () => {
  await prisma?.$disconnect()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan.
  }
})

beforeEach(async () => {
  await prisma.reportDelivery.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.transactionItem.deleteMany()
  await prisma.transaction.deleteMany()
})

/** Satu penjualan tunai lunas pada businessDate tertentu. */
async function seedSale(businessDate: string, qty: number): Promise<void> {
  const netTotal = 2_000 * qty
  const trx = await prisma.transaction.create({
    data: {
      trxNumber: `TRX-${businessDate.replaceAll('-', '')}-${String(qty).padStart(6, '0')}`,
      businessDate,
      shiftId,
      cashierId,
      status: 'COMPLETED',
      grossSubtotal: netTotal,
      itemDiscountTotal: 0,
      transactionDiscount: 0,
      netTotal,
      cogsTotal: 1_400 * qty,
      completedAt: new Date(`${businessDate}T10:00:00Z`),
      items: {
        create: [
          {
            productId,
            productName: 'Kopi Sachet',
            sku: 'LAP-001',
            unitPrice: 2_000,
            unitCost: 1_400,
            qty,
            lineGross: netTotal,
            itemDiscount: 0,
            allocatedTxDiscount: 0,
            lineNet: netTotal,
            lineFinal: netTotal,
          },
        ],
      },
    },
  })

  await prisma.payment.create({
    data: {
      transactionId: trx.id,
      method: 'CASH',
      status: 'PAID',
      amount: netTotal,
      amountTendered: netTotal,
      changeAmount: 0,
      providerName: 'cash',
      paidAt: new Date(`${businessDate}T10:00:00Z`),
    },
  })
}

async function seedSentDelivery(periodKey: string): Promise<void> {
  await prisma.reportDelivery.create({
    data: {
      kind: 'DAILY',
      periodKey,
      channel: 'DISCORD',
      trigger: 'AUTO',
      status: 'SENT',
      attempts: 1,
      sentAt: new Date(`${periodKey}T22:00:00Z`),
      dedupeKey: `DAILY|${periodKey}|DISCORD`,
    },
  })
}

/** 2026-09-18 08:00 WIB. */
const NOW = new Date('2026-09-18T01:00:00Z')

describe('server mati 3 hari', () => {
  beforeEach(async () => {
    await seedSale('2026-09-15', 3)
    await seedSale('2026-09-16', 5)
    await seedSale('2026-09-17', 2)
    await seedSale('2026-09-18', 1)
    await seedSentDelivery('2026-09-14')
  })

  it('mengirim tepat 3 laporan, urut, dan TIDAK mengirim hari ini', async () => {
    const { provider, sent } = fakeProvider()
    const result = await catchUpReports(NOW, catchUpOptions(provider))

    expect(result.sent.map((s) => s.periodKey)).toEqual([
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
    ])
    expect(result.failed).toEqual([])
    expect(sent).toHaveLength(3)

    // Hari ini belum berakhir, jadi angkanya belum final dan tidak dikirim
    // otomatis (docs/reporting.md §6.2).
    const rows = await prisma.reportDelivery.findMany({ orderBy: { periodKey: 'asc' } })
    expect(rows.map((r) => r.periodKey)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
    ])
    expect(rows.every((r) => r.status === 'SENT')).toBe(true)
  })

  it('laporan yang dikirim memuat angka hari itu, bukan gabungan', async () => {
    const { provider, sent } = fakeProvider()
    await catchUpReports(NOW, catchUpOptions(provider))

    // 2026-09-16: 5 × Rp 2.000
    const tanggal16 = sent.find((m) => m.periodLabel.includes('16 September'))
    const penjualan = tanggal16?.sections.find((s) => s.label === 'Penjualan')
    expect(penjualan?.rows.find((r) => r.label === 'Penjualan Bersih')?.value).toBe('Rp 10.000')
  })

  it('run kedua tidak mengirim apa pun — klaim ditolak database', async () => {
    const pertama = fakeProvider()
    await catchUpReports(NOW, catchUpOptions(pertama.provider))

    const kedua = fakeProvider()
    const result = await catchUpReports(NOW, catchUpOptions(kedua.provider))

    expect(kedua.sent).toHaveLength(0)
    expect(result.sent).toEqual([])
    expect(await prisma.reportDelivery.count()).toBe(4)
  })

  it('provider gagal total: 3 baris FAILED dengan lastError, aplikasi tidak crash', async () => {
    const { provider, sent } = fakeProvider({
      fail: new SendError('Discord tidak bisa dihubungi: ECONNREFUSED', { retryable: true }),
    })

    const result = await catchUpReports(NOW, catchUpOptions(provider))

    expect(sent).toHaveLength(0)
    expect(result.failed).toHaveLength(3)

    const gagal = await prisma.reportDelivery.findMany({ where: { status: 'FAILED' } })
    expect(gagal).toHaveLength(3)
    expect(gagal[0]?.lastError).toContain('ECONNREFUSED')
    // Masih dijadwalkan untuk dicoba lagi, karena kegagalannya sementara.
    expect(gagal[0]?.nextAttemptAt).not.toBeNull()
  })

  it('yang gagal dipungut lagi pada catch-up berikutnya, lalu berhasil', async () => {
    const rusak = fakeProvider({
      fail: new SendError('mati', { retryable: true }),
    })
    await catchUpReports(NOW, catchUpOptions(rusak.provider))
    expect(await prisma.reportDelivery.count({ where: { status: 'FAILED' } })).toBe(3)

    // Internet toko kembali; catch-up berikutnya memungut baris yang tertinggal.
    const pulih = fakeProvider()
    const nanti = new Date(NOW.getTime() + 60 * 60_000)
    const result = await catchUpReports(nanti, catchUpOptions(pulih.provider))

    expect(result.resumed).toHaveLength(3)
    expect(pulih.sent).toHaveLength(3)
    expect(await prisma.reportDelivery.count({ where: { status: 'FAILED' } })).toBe(0)
    expect(await prisma.reportDelivery.count({ where: { status: 'SENT' } })).toBe(4)
  })

  it('kegagalan permanen tidak dijadwalkan ulang otomatis', async () => {
    const { provider } = fakeProvider({
      fail: new SendError('Unknown Webhook', { retryable: false, status: 404 }),
    })
    await catchUpReports(NOW, catchUpOptions(provider))

    const gagal = await prisma.reportDelivery.findMany({ where: { status: 'FAILED' } })
    expect(gagal).toHaveLength(3)
    // Mencoba lagi tiap sepuluh menit selamanya hanya menumpuk baris gagal yang
    // sama; baris ini menunggu pemilik membetulkan pengaturan lalu retry manual.
    expect(gagal.every((g) => g.nextAttemptAt === null)).toBe(true)

    const pulih = fakeProvider()
    const nanti = new Date(NOW.getTime() + 24 * 60 * 60_000)
    const result = await catchUpReports(nanti, catchUpOptions(pulih.provider))
    expect(result.resumed).toHaveLength(0)
  })
})

describe('batas backlog', () => {
  it('laptop mati enam bulan tidak mengirim 180 pesan', async () => {
    await seedSale('2026-03-01', 1)
    await seedSentDelivery('2026-03-01')

    const { provider, sent } = fakeProvider()
    const result = await catchUpReports(NOW, { ...catchUpOptions(provider), cap: 5 })

    expect(result.sent).toHaveLength(5)
    expect(sent).toHaveLength(5)
    // Yang disisakan adalah yang paling baru — laporan minggu lalu lebih
    // berguna daripada laporan lima bulan lalu.
    expect(result.sent.at(-1)?.periodKey).toBe('2026-09-17')
  })
})

describe('instalasi baru', () => {
  it('mulai dari transaksi paling awal, bukan dari awal waktu', async () => {
    await seedSale('2026-09-16', 4)
    await seedSale('2026-09-17', 4)

    const { provider } = fakeProvider()
    const result = await catchUpReports(NOW, catchUpOptions(provider))

    expect(result.sent.map((s) => s.periodKey)).toEqual(['2026-09-16', '2026-09-17'])
  })

  it('belum ada transaksi sama sekali: tidak ada yang dikirim', async () => {
    const { provider, sent } = fakeProvider()
    const result = await catchUpReports(NOW, catchUpOptions(provider))

    expect(result.sent).toEqual([])
    expect(sent).toHaveLength(0)
    expect(await prisma.reportDelivery.count()).toBe(0)
  })
})

describe('pengiriman manual vs otomatis', () => {
  beforeEach(async () => {
    await seedSale('2026-09-18', 7)
  })

  it('manual boleh mengirim periode yang BELUM selesai', async () => {
    const { provider, sent } = fakeProvider()
    const siang = new Date('2026-09-18T08:00:00Z') // 15:00 WIB

    const hasil = await deliverReport('DAILY', '2026-09-18', 'DISCORD', 'MANUAL', {
      db: prisma,
      now: siang,
      providerFor: () => provider,
      sendOptions: noRetry,
    })

    expect(hasil.status).toBe('SENT')
    expect(sent).toHaveLength(1)
  })

  it('kirim manual dua kali untuk periode yang sama BERHASIL, tanpa error constraint', async () => {
    const { provider, sent } = fakeProvider()
    const opts = {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
    }

    const satu = await deliverReport('DAILY', '2026-09-18', 'DISCORD', 'MANUAL', opts)
    const dua = await deliverReport('DAILY', '2026-09-18', 'DISCORD', 'MANUAL', opts)

    // Menekan "Kirim laporan sekarang" dua kali adalah hal wajar — pesan
    // pertama terlewat, atau pemilik ingin mengirim ulang. Itu tidak boleh
    // berakhir sebagai error database (docs/reporting.md §6.3).
    expect(satu.status).toBe('SENT')
    expect(dua.status).toBe('SENT')
    expect(sent).toHaveLength(2)

    const rows = await prisma.reportDelivery.findMany({ where: { trigger: 'MANUAL' } })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.dedupeKey === null)).toBe(true)
  })

  it('pengiriman manual TIDAK menghalangi pengiriman otomatis setelah harinya berakhir', async () => {
    const { provider } = fakeProvider()
    const siang = new Date('2026-09-18T08:00:00Z')

    await deliverReport('DAILY', '2026-09-18', 'DISCORD', 'MANUAL', {
      db: prisma,
      now: siang,
      providerFor: () => provider,
      sendOptions: noRetry,
    })

    // Besok paginya, catch-up berjalan seperti biasa.
    const besok = new Date('2026-09-19T01:00:00Z')
    const hasil = await catchUpReports(besok, catchUpOptions(provider))

    expect(hasil.sent.map((s) => s.periodKey)).toContain('2026-09-18')

    const auto = await prisma.reportDelivery.findMany({ where: { trigger: 'AUTO' } })
    expect(auto).toHaveLength(1)
    expect(auto[0]?.dedupeKey).toBe('DAILY|2026-09-18|DISCORD')
  })

  it('klaim otomatis kedua untuk periode yang sama dilewati, bukan error', async () => {
    const { provider } = fakeProvider()
    const opts = {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
    }

    const satu = await deliverReport('DAILY', '2026-09-17', 'DISCORD', 'AUTO', opts)
    const dua = await deliverReport('DAILY', '2026-09-17', 'DISCORD', 'AUTO', opts)

    expect(satu.status).toBe('SENT')
    expect(dua.status).toBe('SKIPPED')
    expect(dua.skippedReason).toMatch(/sudah pernah/i)
  })
})

describe('beberapa jenis laporan sekaligus', () => {
  it('harian, mingguan, dan bulanan tidak saling menimpa', async () => {
    await seedSale('2026-08-31', 2)
    await seedSale('2026-09-17', 2)

    const { provider } = fakeProvider()
    const result = await catchUpReports(NOW, {
      ...catchUpOptions(provider),
      kinds: ['DAILY', 'WEEKLY', 'MONTHLY'],
      cap: 3,
    })

    const kinds = new Set(result.sent.map((s) => s.kind))
    expect(kinds.has('DAILY')).toBe(true)
    expect(kinds.has('WEEKLY')).toBe(true)
    expect(kinds.has('MONTHLY')).toBe(true)

    // Kunci unik memisahkan ketiganya walaupun periodKey-nya berbeda bentuk.
    const rows = await prisma.reportDelivery.findMany()
    const keys = rows.map((r) => r.dedupeKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('tanpa saluran terkonfigurasi', () => {
  it('bukan kegagalan, dan tidak menumpuk baris FAILED', async () => {
    await seedSale('2026-09-17', 1)

    const result = await catchUpReports(NOW, {
      db: prisma,
      channels: [],
      kinds: ['DAILY'],
      sleep: noSleep,
      betweenSendsMs: 0,
    })

    expect(result.note).toMatch(/belum ada saluran/i)
    expect(result.sent).toEqual([])
    expect(await prisma.reportDelivery.count()).toBe(0)
  })
})
