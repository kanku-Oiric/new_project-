import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { NotificationProvider, ReportMessage } from '@/lib/notify/types'

/**
 * Perilaku dengan `AI_ENABLED=true`, tanpa satu pun request ke internet.
 *
 * Seluruh jawaban Gemini disuntik lewat `fetchImpl`, jadi test ini bisa
 * memeriksa hal-hal yang mustahil diuji terhadap API sungguhan: jawaban ngawur,
 * jawaban kosong, HTTP 500, dan kuota yang habis.
 *
 * Berkasnya terpisah dari `tests/ai-disabled.test.ts` karena `src/lib/config.ts`
 * membaca environment sekali saat modul dimuat.
 */

let prisma: PrismaClient
let tmpDir = ''
let requestInsight: typeof import('@/lib/ai/service').requestInsight
let readCachedInsight: typeof import('@/lib/ai/cache').readCachedInsight
let buildReport: typeof import('@/lib/report/service').buildReport
let deliverReport: typeof import('@/lib/report/service').deliverReport

/** Hari usaha yang dipakai seluruh test di sini: Senin, 21 September 2026 WIB. */
const NOW = new Date('2026-09-21T05:00:00Z')
const BUSINESS_DATE = '2026-09-21'
const PERIOD = '2026-W38'

const JAWABAN_SAH = {
  ringkasan: 'Penjualan pekan ini didorong satu produk saja, dan selisih kas masih nol.',
  temuan: ['Produk AiOn menyumbang seluruh penjualan', 'Tidak ada refund pekan ini'],
  saran: ['Tambah variasi produk', 'Pantau stok produk terlaris'],
}

/** fetch palsu yang menjawab seperti Gemini. */
function fetchYangMenjawab(text: string, status = 200): { impl: typeof fetch; hitung: () => number } {
  let dipanggil = 0
  const impl = (async () => {
    dipanggil++
    if (status !== 200) return new Response('kesalahan dari sisi Google', { status })
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { impl, hitung: () => dipanggil }
}

function fetchYangTidakBolehDipanggil(): { impl: typeof fetch; hitung: () => number } {
  let dipanggil = 0
  const impl = (async () => {
    dipanggil++
    throw new Error('fetch dipanggil padahal seharusnya tidak')
  }) as typeof fetch
  return { impl, hitung: () => dipanggil }
}

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

async function input() {
  const built = await buildReport('WEEKLY', PERIOD, prisma)
  return {
    kind: 'WEEKLY' as const,
    periodKey: PERIOD,
    aggregate: built.aggregate,
    comparison: built.comparison,
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-ai-on-'))
  const dbPath = path.join(tmpDir, 'ai-on.db')

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, stdio: 'pipe' },
  )

  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`
  process.env.AI_ENABLED = 'true'
  process.env.GEMINI_API_KEY = 'kunci-uji-RAHASIA'
  process.env.GEMINI_MODEL = 'gemini-uji'
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups')

  const ai = await import('@/lib/ai/service')
  requestInsight = ai.requestInsight
  const cache = await import('@/lib/ai/cache')
  readCachedInsight = cache.readCachedInsight
  const report = await import('@/lib/report/service')
  buildReport = report.buildReport
  deliverReport = report.deliverReport

  const db = await import('@/lib/db/prisma')
  prisma = db.prisma

  const cashier = await prisma.user.create({
    data: { name: 'Kasir AiOn', role: 'CASHIER', pinHash: 'x' },
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
      sku: 'AI-ON-1',
      nama: 'Produk AiOn',
      searchKey: 'produk aion',
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
  await prisma.setting.create({ data: { key: 'storeName', value: 'Toko AiOn' } })
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
  await prisma.aiInsight.deleteMany()
  await prisma.aiCallLog.deleteMany()
})

describe('jalur berhasil', () => {
  it('menyimpan hasil yang lolos validasi dan mencatat panggilannya', async () => {
    const { impl, hitung } = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))

    const hasil = await requestInsight(await input(), {
      db: prisma,
      now: NOW,
      fetchImpl: impl,
      requestedByUserId: null,
    })

    expect(hasil.status).toBe('FRESH')
    expect(hasil.text).toContain('Penjualan pekan ini')
    expect(hasil.text).toContain('• Tambah variasi produk')
    expect(hitung()).toBe(1)

    const insight = await prisma.aiInsight.findFirstOrThrow()
    expect(insight.kind).toBe('WEEKLY')
    expect(insight.periodKey).toBe(PERIOD)
    expect(insight.model).toBe('gemini-uji')

    const log = await prisma.aiCallLog.findFirstOrThrow()
    expect(log.ok).toBe(true)
    expect(log.businessDate).toBe(BUSINESS_DATE)
    expect(log.errorMessage).toBeNull()
  })

  it('panggilan kedua untuk periode sama memakai cache, TANPA request', async () => {
    const pertama = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))
    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: pertama.impl })

    const kedua = fetchYangTidakBolehDipanggil()
    const hasil = await requestInsight(await input(), {
      db: prisma,
      now: NOW,
      fetchImpl: kedua.impl,
    })

    expect(hasil.status).toBe('CACHED')
    expect(hasil.text).toContain('Penjualan pekan ini')
    expect(kedua.hitung()).toBe(0)
    // Cache dibaca sebelum gerbang kuota, jadi tidak ada panggilan tambahan
    // yang tercatat.
    expect(await prisma.aiCallLog.count()).toBe(1)
  })

  it('kunci API TIDAK ikut ke URL', async () => {
    let url = ''
    const impl = (async (target: unknown) => {
      url = String(target)
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(JAWABAN_SAH) }] } }] }),
        { status: 200 },
      )
    }) as typeof fetch

    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })
    expect(url).not.toContain('RAHASIA')
  })
})

describe('response invalid dari Gemini', () => {
  it('teks biasa (bukan JSON) → INVALID, tidak crash', async () => {
    const { impl } = fetchYangMenjawab('Tentu! Penjualan minggu ini bagus sekali.')

    const hasil = await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })

    expect(hasil.status).toBe('INVALID')
    expect(hasil.text).toBeNull()
    expect(hasil.message).toContain('dilewati')
  })

  it('keluaran invalid TIDAK tersimpan ke ai_insights', async () => {
    const { impl } = fetchYangMenjawab(JSON.stringify({ ringkasan: 'kurang field' }))

    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })

    // Hanya hasil yang lolos validasi boleh tersimpan (architecture.md §12).
    expect(await prisma.aiInsight.count()).toBe(0)

    const log = await prisma.aiCallLog.findFirstOrThrow()
    expect(log.ok).toBe(false)
    expect(log.errorMessage).toContain('tidak sesuai skema')
  })

  it('JSON dengan tipe salah → INVALID', async () => {
    const { impl } = fetchYangMenjawab(
      JSON.stringify({ ...JAWABAN_SAH, temuan: 'seharusnya array' }),
    )
    const hasil = await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })
    expect(hasil.status).toBe('INVALID')
    expect(await prisma.aiInsight.count()).toBe(0)
  })

  it('HTTP 500 dari Gemini → FAILED, tercatat, tidak melempar', async () => {
    const { impl } = fetchYangMenjawab('', 500)
    const hasil = await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })

    expect(hasil.status).toBe('FAILED')
    expect(await prisma.aiInsight.count()).toBe(0)
    const log = await prisma.aiCallLog.findFirstOrThrow()
    expect(log.ok).toBe(false)
    expect(log.errorMessage).toContain('500')
  })

  it('pesan error TIDAK memuat kunci API', async () => {
    const impl = (async () =>
      new Response('kesalahan untuk kunci kunci-uji-RAHASIA', { status: 403 })) as typeof fetch

    const hasil = await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })

    expect(hasil.status).toBe('FAILED')
    expect(hasil.message).not.toContain('RAHASIA')
    const log = await prisma.aiCallLog.findFirstOrThrow()
    // Pesan error berakhir di tabel ini, di berkas log, dan di layar pemilik.
    expect(log.errorMessage).not.toContain('RAHASIA')
    expect(log.errorMessage).toContain('<api-key>')
  })
})

describe('batas satu panggilan per hari', () => {
  it('panggilan kedua pada hari yang sama ditolak SEBELUM request', async () => {
    const pertama = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))
    const satu = await requestInsight(await input(), {
      db: prisma,
      now: NOW,
      fetchImpl: pertama.impl,
    })
    expect(satu.status).toBe('FRESH')

    // Periode LAIN, supaya cache tidak yang menahannya — yang harus menahan
    // adalah kuota.
    const built = await buildReport('MONTHLY', '2026-09', prisma)
    const kedua = fetchYangTidakBolehDipanggil()
    const dua = await requestInsight(
      {
        kind: 'MONTHLY',
        periodKey: '2026-09',
        aggregate: built.aggregate,
        comparison: built.comparison,
      },
      { db: prisma, now: NOW, fetchImpl: kedua.impl },
    )

    expect(dua.status).toBe('LIMIT_REACHED')
    expect(dua.message).toContain('Coba lagi besok')
    expect(kedua.hitung()).toBe(0)
  })

  it('panggilan yang GAGAL tetap menghabiskan kuota', async () => {
    // Keputusan yang disengaja: kunci rusak atau model yang terus menjawab salah
    // tidak boleh ditembak berulang kali sepanjang hari. Biayanya nyata, dan
    // tagihannya ke pemilik toko.
    const gagal = fetchYangMenjawab('bukan json', 200)
    const satu = await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: gagal.impl })
    expect(satu.status).toBe('INVALID')

    const kedua = fetchYangTidakBolehDipanggil()
    const built = await buildReport('MONTHLY', '2026-09', prisma)
    const dua = await requestInsight(
      {
        kind: 'MONTHLY',
        periodKey: '2026-09',
        aggregate: built.aggregate,
        comparison: built.comparison,
      },
      { db: prisma, now: NOW, fetchImpl: kedua.impl },
    )

    expect(dua.status).toBe('LIMIT_REACHED')
    expect(kedua.hitung()).toBe(0)
  })

  it('besok kuotanya kembali', async () => {
    const hariIni = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))
    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: hariIni.impl })

    const besok = new Date('2026-09-22T05:00:00Z')
    const built = await buildReport('MONTHLY', '2026-09', prisma)
    const esok = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))

    const hasil = await requestInsight(
      {
        kind: 'MONTHLY',
        periodKey: '2026-09',
        aggregate: built.aggregate,
        comparison: built.comparison,
      },
      { db: prisma, now: besok, fetchImpl: esok.impl },
    )

    expect(hasil.status).toBe('FRESH')
    expect(esok.hitung()).toBe(1)
  })

  it('refresh saat kuota habis menampilkan hasil tersimpan, bukan layar kosong', async () => {
    const pertama = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))
    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: pertama.impl })

    const kedua = fetchYangTidakBolehDipanggil()
    const hasil = await requestInsight(await input(), {
      db: prisma,
      now: NOW,
      refresh: true,
      fetchImpl: kedua.impl,
    })

    expect(hasil.status).toBe('CACHED')
    expect(hasil.text).toContain('Penjualan pekan ini')
    expect(hasil.message).toContain('Kuota analisis hari ini sudah terpakai')
    expect(kedua.hitung()).toBe(0)
  })

  it('laporan HARIAN tidak pernah dianalisis, dan tidak menghabiskan kuota', async () => {
    const built = await buildReport('DAILY', '2026-09-15', prisma)
    const { impl, hitung } = fetchYangTidakBolehDipanggil()

    const hasil = await requestInsight(
      // Sengaja dipaksa lewat cast: gerbangnya harus ada di runtime, bukan hanya
      // di tipe. Client yang dimodifikasi tidak dibatasi TypeScript.
      {
        kind: 'DAILY' as unknown as 'WEEKLY',
        periodKey: '2026-09-15',
        aggregate: built.aggregate,
        comparison: null,
      },
      { db: prisma, now: NOW, fetchImpl: impl },
    )

    expect(hasil.status).toBe('UNSUPPORTED_KIND')
    expect(hitung()).toBe(0)
    expect(await prisma.aiCallLog.count()).toBe(0)
  })
})

describe('pengiriman laporan', () => {
  it('analisis yang tersimpan ikut terkirim ke saluran notifikasi', async () => {
    const { impl } = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))
    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })

    const { provider, sent } = fakeProvider()
    const hasil = await deliverReport('WEEKLY', PERIOD, 'DISCORD', 'MANUAL', {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
    })

    expect(hasil.status).toBe('SENT')
    expect(sent[0]?.aiInsight).toContain('Penjualan pekan ini')
  })

  it('analisis yang GAGAL tidak menggagalkan pengiriman laporan', async () => {
    // Ini inti aturannya: kegagalan di bagian pinggir tidak boleh menjatuhkan
    // bagian yang penting.
    const { provider, sent } = fakeProvider()

    const hasil = await deliverReport('WEEKLY', PERIOD, 'DISCORD', 'MANUAL', {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
      insightFor: async () => {
        throw new Error('analisis meledak')
      },
    })

    expect(hasil.status).toBe('SENT')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.aiInsight).toBeUndefined()
    // Angka laporannya tetap utuh.
    expect(sent[0]?.sections.length).toBeGreaterThan(0)
  })

  it('analisis yang menjawab null membuat laporan terkirim tanpa bagian itu', async () => {
    const { provider, sent } = fakeProvider()

    const hasil = await deliverReport('WEEKLY', PERIOD, 'DISCORD', 'MANUAL', {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
      insightFor: async () => null,
    })

    expect(hasil.status).toBe('SENT')
    expect(sent[0]?.aiInsight).toBeUndefined()
  })

  it('pengiriman laporan HARIAN tidak pernah meminta analisis', async () => {
    let diminta = 0
    const { provider } = fakeProvider()

    await deliverReport('DAILY', '2026-09-15', 'DISCORD', 'MANUAL', {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
      insightFor: async () => {
        diminta++
        return 'seharusnya tidak dipakai'
      },
    })

    expect(diminta).toBe(0)
  })

  it('pengiriman ULANG periode yang sama tidak memanggil API kedua kali', async () => {
    const { impl, hitung } = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))
    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: impl })
    expect(hitung()).toBe(1)

    let diminta = 0
    const { provider, sent } = fakeProvider()
    const opts = {
      db: prisma,
      now: NOW,
      providerFor: () => provider,
      sendOptions: noRetry,
      insightFor: async () => {
        diminta++
        return null
      },
    }

    await deliverReport('WEEKLY', PERIOD, 'DISCORD', 'MANUAL', opts)
    await deliverReport('WEEKLY', PERIOD, 'DISCORD', 'MANUAL', opts)

    // buildReport sudah menempelkan hasil tersimpan, jadi jalur generasi tidak
    // pernah tersentuh.
    expect(diminta).toBe(0)
    expect(sent).toHaveLength(2)
    expect(sent[0]?.aiInsight).toContain('Penjualan pekan ini')
    expect(sent[1]?.aiInsight).toContain('Penjualan pekan ini')
  })
})

describe('append-only ai_insights', () => {
  it('analisis ulang membuat BARIS BARU, bukan menimpa', async () => {
    const satu = fetchYangMenjawab(JSON.stringify(JAWABAN_SAH))
    await requestInsight(await input(), { db: prisma, now: NOW, fetchImpl: satu.impl })

    const besok = new Date('2026-09-22T05:00:00Z')
    const lain = {
      ...JAWABAN_SAH,
      ringkasan: 'Analisis kedua dengan kesimpulan yang sedikit berbeda dari sebelumnya.',
    }
    const dua = fetchYangMenjawab(JSON.stringify(lain))
    await requestInsight(await input(), {
      db: prisma,
      now: besok,
      refresh: true,
      fetchImpl: dua.impl,
    })

    const semua = await prisma.aiInsight.findMany({ orderBy: { createdAt: 'asc' } })
    expect(semua).toHaveLength(2)

    // Pembaca mengambil yang terbaru.
    const cached = await readCachedInsight('WEEKLY', PERIOD, prisma)
    expect(cached?.text).toContain('Analisis kedua')
  })

  it('baris ai_insights yang rusak dianggap tidak ada, bukan menjatuhkan halaman', async () => {
    await prisma.aiInsight.create({
      data: {
        kind: 'WEEKLY',
        periodKey: PERIOD,
        model: 'gemini-uji',
        insightJson: '{ ini bukan json yang benar',
      },
    })

    const cached = await readCachedInsight('WEEKLY', PERIOD, prisma)
    expect(cached).toBeNull()

    // Dan laporannya tetap bisa disusun.
    const built = await buildReport('WEEKLY', PERIOD, prisma)
    expect(built.message.aiInsight).toBeUndefined()
  })
})
