import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NotificationProvider, ReportMessage } from '@/lib/notify/types'

/**
 * Perilaku dengan `AI_ENABLED=false` — keadaan DEFAULT sistem ini.
 *
 * Yang dibuktikan di sini bukan "fiturnya mati", tapi sesuatu yang lebih keras:
 * **tidak ada satu pun request yang dibuat.** `fetch` global diganti dengan
 * fungsi yang menggagalkan test kalau dipanggil, jadi kalau suatu hari ada jalur
 * yang menembus gerbang AI_ENABLED, test ini merah — bukan diam-diam menagih
 * pemilik toko.
 *
 * Berkasnya terpisah dari `tests/ai.test.ts` dengan sengaja: `src/lib/config.ts`
 * membaca environment SEKALI saat modul dimuat, jadi menyalakan dan mematikan AI
 * di satu proses menuntut reset module yang rapuh. Dua berkas, dua proses, dua
 * keadaan yang benar-benar terpisah.
 */

let prisma: PrismaClient
let tmpDir = ''
let requestInsight: typeof import('@/lib/ai/service').requestInsight
let buildReport: typeof import('@/lib/report/service').buildReport
let deliverReport: typeof import('@/lib/report/service').deliverReport
let fetchDipanggil = 0

const noSleep = async (): Promise<void> => undefined
const noRetry = { sleep: noSleep, random: () => 0, maxAttempts: 1 }

function fakeProvider(): { provider: NotificationProvider; sent: ReportMessage[] } {
  const sent: ReportMessage[] = []
  return {
    sent,
    provider: {
      channel: 'DISCORD',
      name: 'uji',
      isConfigured: async () => true,
      describe: async () => ({ configured: true, label: 'uji', hint: null }),
      send: async (message) => {
        sent.push(message)
      },
    },
  }
}

const NOW = new Date('2026-09-21T05:00:00Z') // Senin 12:00 WIB

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-ai-off-'))
  const dbPath = path.join(tmpDir, 'ai-off.db')

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, stdio: 'pipe' },
  )

  // Keadaan default: AI mati, dan kunci API SENGAJA diisi. Kalau gerbang yang
  // menentukan adalah ada-tidaknya kunci alih-alih AI_ENABLED, test ini akan
  // menangkapnya.
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`
  process.env.AI_ENABLED = 'false'
  process.env.GEMINI_API_KEY = 'kunci-yang-tidak-boleh-dipakai'
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups')

  // Jaring utama berkas ini: tidak ada request yang boleh keluar.
  globalThis.fetch = (async () => {
    fetchDipanggil++
    throw new Error('fetch dipanggil padahal AI_ENABLED=false')
  }) as typeof fetch

  const ai = await import('@/lib/ai/service')
  requestInsight = ai.requestInsight
  const report = await import('@/lib/report/service')
  buildReport = report.buildReport
  deliverReport = report.deliverReport

  const db = await import('@/lib/db/prisma')
  prisma = db.prisma

  const cashier = await prisma.user.create({
    data: { name: 'Kasir AiOff', role: 'CASHIER', pinHash: 'x' },
  })
  const shift = await prisma.shift.create({
    data: {
      cashierId: cashier.id,
      status: 'CLOSED',
      openingCash: 0,
      businessDate: '2026-09-15',
      openedAt: new Date('2026-09-15T01:00:00Z'),
      closedAt: new Date('2026-09-15T13:00:00Z'),
    },
  })
  const product = await prisma.product.create({
    data: {
      sku: 'AI-OFF-1',
      nama: 'Produk AiOff',
      searchKey: 'produk aioff',
      kategori: 'Uji',
      hargaJual: 10_000,
      hargaBeli: 6_000,
      stok: 50,
      stokMinimum: 5,
    },
  })

  const trx = await prisma.transaction.create({
    data: {
      trxNumber: 'TRX-20260915-000001',
      businessDate: '2026-09-15',
      shiftId: shift.id,
      cashierId: cashier.id,
      status: 'COMPLETED',
      completedAt: new Date('2026-09-15T04:00:00Z'),
      grossSubtotal: 20_000,
      itemDiscountTotal: 0,
      transactionDiscount: 0,
      netTotal: 20_000,
      cogsTotal: 12_000,
    },
  })
  await prisma.transactionItem.create({
    data: {
      transactionId: trx.id,
      productId: product.id,
      productName: product.nama,
      sku: product.sku,
      unitPrice: 10_000,
      unitCost: 6_000,
      qty: 2,
      lineGross: 20_000,
      itemDiscount: 0,
      allocatedTxDiscount: 0,
      lineNet: 20_000,
      lineFinal: 20_000,
    },
  })
  await prisma.payment.create({
    data: {
      transactionId: trx.id,
      method: 'CASH',
      status: 'PAID',
      amount: 20_000,
      providerName: 'cash',
      paidAt: new Date('2026-09-15T04:00:00Z'),
    },
  })
  await prisma.setting.create({ data: { key: 'storeName', value: 'Toko AiOff' } })
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan.
  }
})

describe('AI_ENABLED=false', () => {
  it('requestInsight menjawab DISABLED tanpa membuat request', async () => {
    const built = await buildReport('WEEKLY', '2026-W38', prisma)
    const hasil = await requestInsight(
      {
        kind: 'WEEKLY',
        periodKey: '2026-W38',
        aggregate: built.aggregate,
        comparison: built.comparison,
      },
      { db: prisma, now: NOW },
    )

    expect(hasil.status).toBe('DISABLED')
    expect(hasil.text).toBeNull()
    expect(hasil.message).toContain('dimatikan')
    expect(fetchDipanggil).toBe(0)
  })

  it('tidak menulis apa pun ke ai_call_logs maupun ai_insights', async () => {
    // Fitur yang mati tidak boleh meninggalkan jejak. Baris di ai_call_logs juga
    // akan salah: ia dipakai menghitung kuota, dan kuota tidak terpakai di sini.
    expect(await prisma.aiCallLog.count()).toBe(0)
    expect(await prisma.aiInsight.count()).toBe(0)
  })

  it('laporan mingguan tetap lengkap, tanpa bagian analisis', async () => {
    const built = await buildReport('WEEKLY', '2026-W38', prisma)

    expect(built.message.sections.length).toBeGreaterThan(0)
    expect(built.aggregate.netSales).toBe(20_000)
    // Tidak ada placeholder dan tidak ada pesan error yang ikut ke pemilik
    // (docs/reporting.md §5.2).
    expect(built.message.aiInsight).toBeUndefined()
  })

  it('pengiriman laporan mingguan BERHASIL dan pesannya tanpa analisis', async () => {
    const { provider, sent } = fakeProvider()

    const hasil = await deliverReport('WEEKLY', '2026-W38', 'DISCORD', 'MANUAL', {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
    })

    expect(hasil.status).toBe('SENT')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.aiInsight).toBeUndefined()
    expect(fetchDipanggil).toBe(0)
  })

  it('laporan harian juga normal, dan tidak pernah menyentuh jalur AI', async () => {
    const { provider, sent } = fakeProvider()

    const hasil = await deliverReport('DAILY', '2026-09-15', 'DISCORD', 'MANUAL', {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
    })

    expect(hasil.status).toBe('SENT')
    expect(sent[0]?.aiInsight).toBeUndefined()
    expect(await prisma.aiCallLog.count()).toBe(0)
    expect(fetchDipanggil).toBe(0)
  })
})
