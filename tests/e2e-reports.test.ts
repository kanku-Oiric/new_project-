import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Laporan lewat HTTP: hak akses, angka, dan penolakan yang jujur.
 *
 * Aturan yang berlaku sejak Fase 2: setiap endpoint yang menyentuh uang wajib
 * diuji di lapisan HTTP, bukan cukup di lapisan service. Laporan memang hanya
 * membaca, tapi angkanya dipakai pemilik untuk mengambil keputusan — dan
 * pengiriman yang mengaku berhasil padahal tidak ada tujuan adalah kebohongan
 * yang paling mudah tidak disadari.
 *
 * Yang TIDAK diuji di sini: pengiriman sungguhan ke Discord/Telegram. Provider
 * menolak URL yang bukan milik Discord, jadi mengarahkannya ke server palsu
 * lokal tidak mungkin — dan test yang benar-benar menembak webhook sungguhan
 * adalah test yang berbahaya untuk dimiliki. Jalur kirimnya diuji di
 * tests/catchup.test.ts dengan provider palsu.
 */

const OWNER_PIN = '135791'
const CASHIER_PIN = '246802'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let ownerId = ''
let cashierId = ''
let productId = ''
let ownerCookie = ''
let cashierCookie = ''
let businessDate = ''

const HARGA_JUAL = 7_000
const HARGA_BELI = 5_000
const STOK_AWAL = 100
const QTY = 3
const DISKON_ITEM = 1_000

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('tidak bisa menentukan port bebas')))
      }
    })
  })
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'tidak pernah menjawab'
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`server tidak siap dalam ${timeoutMs}ms: ${lastError}`)
}

async function api(
  method: string,
  pathname: string,
  body?: unknown,
  cookie = ownerCookie,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, data }
}

async function login(userId: string, pin: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-lap-'))
  const dbUrl = `file:${path.join(tmpDir, 'lap.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const owner = await prisma.user.create({
    data: { name: 'Pemilik Laporan', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  ownerId = owner.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir Laporan', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'LAP-001',
      barcode: '7772222222222',
      nama: 'Teh Kotak 250ml',
      searchKey: 'teh kotak 250ml lap-001',
      kategori: 'Minuman',
      hargaJual: HARGA_JUAL,
      hargaBeli: HARGA_BELI,
      stok: STOK_AWAL,
      stokMinimum: 5,
    },
  })
  productId = product.id

  for (const [key, value] of Object.entries({
    storeName: 'Toko Laporan',
    timezone: 'Asia/Jakarta',
    expenseCategories: JSON.stringify(['Operasional', 'Lain-lain']),
  })) {
    await prisma.setting.create({ data: { key, value } })
  }

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`

  server = spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '-p',
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        NODE_ENV: 'development',
        NEXT_DIST_DIR: '.next-reports',
        UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      },
      stdio: 'pipe',
    },
  )
  server.stderr?.on('data', () => {
    // Kegagalan muncul sebagai status HTTP di assertion.
  })

  await waitForServer(`${baseUrl}/api/health`, 120_000)

  const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
    businessDate: string
  }
  businessDate = health.businessDate
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect()
  if (server?.pid) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'pipe' })
      } catch {
        // Proses mungkin sudah mati lebih dulu.
      }
    } else {
      server.kill('SIGTERM')
    }
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan.
  }
}, 60_000)

describe('laporan lewat HTTP', () => {
  let trxVoid = ''

  it('1. kasir TIDAK boleh membuka laporan — HPP dan laba bukan konsumsinya', async () => {
    cashierCookie = await login(cashierId, CASHIER_PIN)

    const res = await api('GET', `/api/reports/daily?date=${businessDate}`, undefined, cashierCookie)
    expect(res.status).toBe(403)
  }, 120_000)

  it('2. tanpa login, laporan ditolak 401', async () => {
    const res = await fetch(`${baseUrl}/api/reports/daily`)
    expect(res.status).toBe(401)
  }, 60_000)

  it('3. dua penjualan, satu di-void: laporan hanya menghitung yang sah', async () => {
    const shift = await api('POST', '/api/shifts/open', { openingCash: 0 }, cashierCookie)
    expect(shift.status).toBe(201)

    const jual = await api(
      'POST',
      '/api/transactions',
      {
        lines: [{ productId, qty: QTY, itemDiscount: DISKON_ITEM }],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 50_000,
      },
      cashierCookie,
    )
    expect(jual.status).toBe(201)

    const dibatalkan = await api(
      'POST',
      '/api/transactions',
      {
        lines: [{ productId, qty: 1, itemDiscount: 0 }],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 10_000,
      },
      cashierCookie,
    )
    expect(dibatalkan.status).toBe(201)
    trxVoid = String(dibatalkan.data.transactionId)

    const batal = await api(
      'POST',
      `/api/transactions/${trxVoid}/void`,
      { ownerPin: OWNER_PIN, reason: 'Salah input kasir' },
      cashierCookie,
    )
    expect(batal.status).toBe(200)

    ownerCookie = await login(ownerId, OWNER_PIN)
    const laporan = await api('GET', `/api/reports/daily?date=${businessDate}`)
    expect(laporan.status).toBe(200)

    const a = laporan.data.aggregate as Record<string, number | null>
    // 3 × 7.000 = 21.000 kotor, diskon item 1.000, bersih 20.000.
    expect(a.grossSales).toBe(21_000)
    expect(a.discounts).toBe(1_000)
    expect(a.netSales).toBe(20_000)
    expect(a.cogs).toBe(15_000)
    expect(a.grossProfit).toBe(5_000)

    // Transaksi yang di-void tidak ikut DI MANA PUN: tidak menambah jumlah
    // transaksi, tidak muncul sebagai angka negatif.
    expect(a.transactionCount).toBe(1)
    expect(a.itemCount).toBe(QTY)
    expect(a.averageTransaction).toBe(20_000)
    expect(a.voidCount).toBe(1)
  }, 120_000)

  it('4. laporan yang ditampilkan adalah pesan yang sama dengan yang dikirim', async () => {
    const laporan = await api('GET', `/api/reports/daily?date=${businessDate}`)
    const message = laporan.data.message as {
      title: string
      sections: { label: string; rows: { label: string; value: string }[] }[]
    }

    expect(message.title).toContain('Toko Laporan')

    const penjualan = message.sections.find((s) => s.label === 'Penjualan')
    expect(penjualan?.rows.find((r) => r.label === 'Penjualan Bersih')?.value).toBe('Rp 20.000')

    // Aturan penamaan docs/reporting.md §1: angka omzet tidak pernah dinamai
    // laba. Baris "Laba Kotor" hanya boleh ada di bagian laba.
    const labelOmzet = penjualan?.rows.map((r) => r.label) ?? []
    expect(labelOmzet.some((l) => /laba/i.test(l))).toBe(false)

    const laba = message.sections.find((s) => s.label === 'Laba kotor')
    expect(laba?.rows.find((r) => r.label === 'Laba Kotor')?.value).toBe('Rp 5.000')
  }, 60_000)

  it('5. hari tanpa transaksi: rata-rata "—", bukan 0 dan bukan NaN', async () => {
    const laporan = await api('GET', '/api/reports/daily?date=2020-01-01')
    expect(laporan.status).toBe(200)

    const a = laporan.data.aggregate as Record<string, number | null>
    expect(a.transactionCount).toBe(0)
    expect(a.averageTransaction).toBeNull()

    const message = laporan.data.message as {
      sections: { label: string; rows: { label: string; value: string }[] }[]
    }
    const aktivitas = message.sections.find((s) => s.label === 'Aktivitas')
    expect(aktivitas?.rows.find((r) => r.label === 'Rata-rata per transaksi')?.value).toBe('—')
  }, 60_000)

  it('6. format periode yang salah ditolak 400, bukan dianggap hari ini', async () => {
    expect((await api('GET', '/api/reports/daily?date=18-09-2026')).status).toBe(400)
    expect((await api('GET', '/api/reports/weekly?week=2026-38')).status).toBe(400)
    expect((await api('GET', '/api/reports/monthly?month=2026-09-18')).status).toBe(400)
  }, 60_000)

  it('7. mingguan dan bulanan memuat perbandingan dengan periode sebelumnya', async () => {
    const mingguan = await api('GET', '/api/reports/weekly')
    expect(mingguan.status).toBe(200)

    const message = mingguan.data.message as { sections: { label: string }[] }
    expect(message.sections.some((s) => s.label === 'Dibanding periode sebelumnya')).toBe(true)

    const bulanan = await api('GET', '/api/reports/monthly')
    expect(bulanan.status).toBe(200)
  }, 60_000)

  it('8. kirim laporan tanpa saluran terkonfigurasi ditolak, tidak mengaku terkirim', async () => {
    const res = await api('POST', '/api/reports/send', {
      kind: 'DAILY',
      periodKey: businessDate,
    })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/belum ada saluran/i)

    // Tidak ada baris pengiriman yang tercipta untuk sesuatu yang tidak pernah
    // dikirim.
    expect(await prisma.reportDelivery.count()).toBe(0)
  }, 60_000)

  it('9. meminta saluran tertentu yang belum siap juga ditolak, dengan namanya', async () => {
    const res = await api('POST', '/api/reports/send', {
      kind: 'DAILY',
      periodKey: businessDate,
      channels: ['TELEGRAM'],
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/TELEGRAM/)
  }, 60_000)

  it('10. pesan uji ke saluran yang belum dikonfigurasi ditolak dengan alasannya', async () => {
    const res = await api('POST', '/api/notifications/test', { channel: 'DISCORD' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/belum dikonfigurasi/i)
  }, 60_000)

  it('11. daftar pengiriman menyebut keadaan sebenarnya, tanpa klaim "tersambung"', async () => {
    const res = await api('GET', '/api/reports/deliveries')
    expect(res.status).toBe(200)

    const channels = res.data.channels as { channel: string; configured: boolean; label: string }[]
    expect(channels).toHaveLength(2)
    expect(channels.every((c) => c.configured === false)).toBe(true)
    expect(JSON.stringify(channels)).not.toMatch(/tersambung|terhubung|terintegrasi/i)

    const kasir = await api('GET', '/api/reports/deliveries', undefined, cashierCookie)
    expect(kasir.status).toBe(403)
  }, 60_000)

  it('12. webhook Discord palsu disimpan tetapi ditolak sebagai konfigurasi', async () => {
    // Bentuk URL diperiksa: salah tempel alamat berarti laporan tidak akan
    // pernah sampai, dan itu harus ketahuan sebelum hari pertama berakhir.
    const simpan = await api('PATCH', '/api/settings', {
      ownerPin: OWNER_PIN,
      values: { discordWebhookUrl: 'https://contoh.com/bukan-webhook' },
    })
    expect(simpan.status).toBe(200)

    const res = await api('GET', '/api/reports/deliveries')
    const channels = res.data.channels as { channel: string; configured: boolean; hint: string }[]
    const discord = channels.find((c) => c.channel === 'DISCORD')
    expect(discord?.configured).toBe(false)
    expect(discord?.hint).toMatch(/discord\.com\/api\/webhooks/i)
  }, 60_000)
})
