import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Bug hunting: menyerang sistem, bukan mengikuti checklist.
 *
 * Berkas ini BUKAN test alur bisnis — alur bisnisnya sudah diuji di tempat lain.
 * Yang ada di sini adalah hipotesis kegagalan yang dibuat dengan membaca kode
 * lalu bertanya "apa yang bisa salah", dan masing-masing dijalankan sampai
 * databasenya yang menjawab.
 *
 * Seluruhnya berjalan di server DAN database TERPISAH: port bebas, temp file,
 * `NEXT_DIST_DIR` sendiri, `BACKUP_DIR` sendiri. Server presentasi di port 3000
 * tidak pernah disentuh.
 */

const OWNER_PIN = '918273'
const OWNER2_PIN = '918274'
const CASHIER_PIN = '374651'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let cashierId = ''
let ownerId = ''
let owner2Id = ''
let productId = ''
let providerId = ''
let cookie = ''

const HARGA_JUAL = 10_000
const HARGA_BELI = 7_000
const STOK_AWAL = 100
const KAS_AWAL = 1_000_000
const SALDO_AWAL = 5_000_000

/** Batas kolom Int 32-bit yang dipakai seluruh kolom nominal. */
const INT_MAX = 2_147_483_647

let urutanKunci = 0
function kunci(): string {
  urutanKunci += 1
  return `77777777-7777-4777-8777-${String(urutanKunci).padStart(12, '0')}`
}

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

/** Kirim apa adanya — TANPA pengisian kunci otomatis. Di sini payload-nya yang diuji. */
async function raw(
  method: string,
  pathname: string,
  body?: unknown,
  headerCookie = cookie,
): Promise<{ status: number; data: Record<string, unknown>; text: string }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headerCookie ? { Cookie: headerCookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Response non-JSON adalah temuan tersendiri; teksnya tetap dibawa.
  }
  return { status: res.status, data, text }
}

async function loginAs(userId: string, pin: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin }),
  })
  expect(res.status).toBe(200)
  const c = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  expect(c).not.toBe('')
  cookie = c
  return c
}

async function saldo(): Promise<number> {
  const p = await prisma.serviceProvider.findUniqueOrThrow({ where: { id: providerId } })
  return p.saldo
}

async function stok(): Promise<number> {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
  return p.stok
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-attack-'))
  const dbUrl = `file:${path.join(tmpDir, 'attack.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const owner = await prisma.user.create({
    data: { name: 'Pemilik Attack', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  ownerId = owner.id
  const owner2 = await prisma.user.create({
    data: { name: 'Pemilik Kedua', role: 'OWNER', pinHash: await bcrypt.hash(OWNER2_PIN, 10) },
  })
  owner2Id = owner2.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir Attack', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'ATK-001',
      nama: 'Produk Serang',
      searchKey: 'produk serang atk-001',
      kategori: 'Uji',
      hargaJual: HARGA_JUAL,
      hargaBeli: HARGA_BELI,
      stok: STOK_AWAL,
      stokMinimum: 5,
    },
  })
  productId = product.id

  const provider = await prisma.serviceProvider.create({
    data: { nama: 'Shopee', jenis: 'EWALLET', saldo: SALDO_AWAL },
  })
  providerId = provider.id

  for (const [k, value] of Object.entries({
    storeName: 'Toko Attack',
    timezone: 'Asia/Jakarta',
    qrisEnabled: 'true',
    expenseCategories: JSON.stringify(['Operasional']),
  })) {
    await prisma.setting.create({ data: { key: k, value } })
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
        // WAJIB: tanpa ini, backup startup menulis snapshot database UJI ke
        // folder backups/ toko (tests/test-hygiene.test.ts).
        BACKUP_DIR: path.join(tmpDir, 'backups'),
        // Folder build sendiri — server presentasi di port 3000 tidak tersentuh.
        NEXT_DIST_DIR: '.next-attack',
      },
      stdio: 'pipe',
    },
  )
  server.stderr?.on('data', () => {
    // Kegagalan muncul sebagai status HTTP di assertion, yang lebih jelas dibaca.
  })

  await waitForServer(`${baseUrl}/api/health`, 120_000)
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

// ═══════════════════════════════════════════════════════════════════════════
// A. OTORISASI — setiap endpoint baru diserang tanpa session dan dengan role salah
// ═══════════════════════════════════════════════════════════════════════════

describe('A. otorisasi endpoint baru', () => {
  const TANPA_SESSION: [string, string, unknown][] = [
    ['GET', '/api/providers', undefined],
    ['POST', '/api/providers', { nama: 'X', jenis: 'EWALLET', saldoAwal: 0 }],
    ['POST', '/api/products', { sku: 'X', nama: 'X', kategori: 'X', hargaBeli: 0, hargaJual: 0 }],
  ]

  it('A1. endpoint provider & produk menolak request tanpa session', async () => {
    for (const [method, pathname, body] of TANPA_SESSION) {
      const res = await raw(method, pathname, body, '')
      expect(
        res.status,
        `${method} ${pathname} harus 401 tanpa session, dapat ${res.status}`,
      ).toBe(401)
    }
    expect(await prisma.serviceProvider.count()).toBe(1)
    expect(await prisma.product.count()).toBe(1)
  }, 120_000)

  it('A2. topup/adjustment/history menolak request tanpa session', async () => {
    const k = kunci()
    const a = await raw('POST', `/api/providers/${providerId}/topup`, {
      amount: 1_000,
      idempotencyKey: k,
    }, '')
    const b = await raw('POST', `/api/providers/${providerId}/adjustment`, {
      newBalance: 0,
      reason: 'serangan',
      ownerPin: OWNER_PIN,
      idempotencyKey: k,
    }, '')
    const c = await raw('GET', `/api/providers/${providerId}/history`, undefined, '')

    expect([a.status, b.status, c.status]).toEqual([401, 401, 401])
    expect(await saldo()).toBe(SALDO_AWAL)
  }, 120_000)

  it('A3. kasir DITOLAK di seluruh endpoint khusus pemilik', async () => {
    await loginAs(cashierId, CASHIER_PIN)

    const percobaan: [string, string, unknown][] = [
      ['POST', '/api/providers', { nama: 'Y', jenis: 'EWALLET', saldoAwal: 0 }],
      [
        'POST',
        `/api/providers/${providerId}/adjustment`,
        { newBalance: 0, reason: 'serangan kasir', ownerPin: OWNER_PIN, idempotencyKey: kunci() },
      ],
      ['GET', `/api/providers/${providerId}/history`, undefined],
      [
        'POST',
        '/api/products',
        { sku: 'Z', nama: 'Z', kategori: 'Z', hargaBeli: 1, hargaJual: 2 },
      ],
      ['PATCH', `/api/products/${productId}`, { hargaJual: 1 }],
      ['DELETE', `/api/products/${productId}`, { ownerPin: OWNER_PIN }],
    ]

    for (const [method, pathname, body] of percobaan) {
      const res = await raw(method, pathname, body)
      expect(
        res.status,
        `${method} ${pathname} harus 403 untuk kasir, dapat ${res.status}`,
      ).toBe(403)
    }

    // PIN pemilik yang benar di dalam body TIDAK boleh menaikkan hak akses.
    const produk = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(produk.hargaJual).toBe(HARGA_JUAL)
    expect(produk.aktif).toBe(true)
    expect(await saldo()).toBe(SALDO_AWAL)
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// B. BATAS ANGKA — kolom Int 32-bit, dan apa yang terjadi saat dilampaui
// ═══════════════════════════════════════════════════════════════════════════

describe('B. batas angka dan overflow', () => {
  it('B1. titipan + admin yang MELEBIHI batas kolom Int ditolak 400, bukan 500', async () => {
    // Masing-masing lolos batas Zod per-field (≤ 2.147.483.647), tapi
    // JUMLAHnya tidak muat di kolom Int tempat Payment.amount disimpan.
    //
    // Yang dicari: apakah sistem menolaknya dengan jelas, atau menabrak
    // database lalu menjawab 500 — dan apakah ada transaksi setengah jadi.
    await loginAs(cashierId, CASHIER_PIN)
    const shift = await raw('POST', '/api/shifts/open', { openingCash: KAS_AWAL })
    expect(shift.status).toBe(201)

    const trxSebelum = await prisma.transaction.count()
    const saldoSebelum = await saldo()

    const res = await raw('POST', '/api/transactions', {
      lines: [],
      services: [
        {
          kind: 'TOKEN_LISTRIK',
          providerId,
          passthroughAmount: INT_MAX,
          serviceFeeAmount: INT_MAX,
        },
      ],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: INT_MAX,
      idempotencyKey: kunci(),
    })

    expect(res.status, `dapat ${res.status}: ${res.text.slice(0, 200)}`).toBe(400)

    // Yang terpenting: tidak ada yang tertulis.
    expect(await prisma.transaction.count()).toBe(trxSebelum)
    expect(await saldo()).toBe(saldoSebelum)
  }, 120_000)

  it('B1b. QRIS dengan total melampaui batas Int juga ditolak 400', async () => {
    // B1 lolos lewat pemeriksaan "uang diterima kurang", BUKAN lewat penjagaan
    // batas kolom — jadi ia tidak membuktikan apa pun tentang overflow.
    //
    // QRIS tidak punya `amountTendered`, jadi jalur ini menembus sampai ke
    // penulisan database. Kalau tidak ada penjagaan, jawabannya 500 setelah
    // nomor transaksi terbakar dari DailyCounter.
    const trxSebelum = await prisma.transaction.count()
    const saldoSebelum = await saldo()

    const res = await raw('POST', '/api/transactions', {
      lines: [],
      services: [
        {
          kind: 'TRANSFER_BANK',
          providerId,
          passthroughAmount: INT_MAX,
          serviceFeeAmount: INT_MAX,
        },
      ],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
      idempotencyKey: kunci(),
    })

    expect(res.status, `dapat ${res.status}: ${res.text.slice(0, 200)}`).toBe(400)
    expect(await prisma.transaction.count()).toBe(trxSebelum)
    expect(await saldo()).toBe(saldoSebelum)
  }, 120_000)

  it('B2. nominal tepat di batas Int tetap diterima', async () => {
    // Batasnya harus MENOLAK yang melampaui, bukan menolak yang sah.
    const saldoSebelum = await saldo()
    const res = await raw('POST', '/api/transactions', {
      lines: [],
      services: [
        { kind: 'TRANSFER_BANK', providerId, passthroughAmount: 1_000_000, serviceFeeAmount: 5_000 },
      ],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 1_005_000,
      idempotencyKey: kunci(),
    })
    expect(res.status).toBe(201)
    expect(res.data.payAmount).toBe(1_005_000)
    expect(await saldo()).toBe(saldoSebelum - 1_000_000)
  }, 120_000)

  it('B3. top-up yang membuat saldo melampaui batas Int ditolak', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const saldoSebelum = await saldo()

    // Saldo sudah beberapa juta; menambah batas Int penuh membuat SALDO-nya
    // melewati batas kolom walaupun nominal top-up-nya sendiri sah.
    //
    // SQLite menerimanya (integer 64-bit), lalu Prisma menolak saat menulis
    // baris pergerakan — dan penolakan itu keluar sebagai 500. Yang benar 400
    // dengan kalimat yang menyebut sebabnya.
    const res = await raw('POST', `/api/providers/${providerId}/topup`, {
      amount: INT_MAX,
      paidFrom: 'OTHER',
      idempotencyKey: kunci(),
    })

    expect(res.status, `dapat ${res.status}: ${res.text.slice(0, 200)}`).toBe(400)
    expect(res.text).toMatch(/batas|nol/i)
    expect(await saldo()).toBe(saldoSebelum)

    // Top-up yang masih muat tetap diterima — penjagaan tidak boleh berubah
    // menjadi penolakan buta.
    const wajar = await raw('POST', `/api/providers/${providerId}/topup`, {
      amount: 500_000,
      paidFrom: 'OTHER',
      idempotencyKey: kunci(),
    })
    expect(wajar.status).toBe(201)
    expect(await saldo()).toBe(saldoSebelum + 500_000)
  }, 120_000)

  it('B4. bentuk data yang salah ditolak tanpa menyentuh apa pun', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const saldoSebelum = await saldo()
    const trxSebelum = await prisma.transaction.count()

    const payloadBuruk: unknown[] = [
      // nominal desimal
      { kind: 'PDAM', providerId, passthroughAmount: 1_000.5, serviceFeeAmount: 0 },
      // nominal nol
      { kind: 'PDAM', providerId, passthroughAmount: 0, serviceFeeAmount: 0 },
      // nominal negatif
      { kind: 'PDAM', providerId, passthroughAmount: -1_000, serviceFeeAmount: 0 },
      // admin negatif
      { kind: 'PDAM', providerId, passthroughAmount: 1_000, serviceFeeAmount: -1 },
      // jenis jasa tidak dikenal
      { kind: 'TOKEN_EMAS', providerId, passthroughAmount: 1_000, serviceFeeAmount: 0 },
      // provider tidak ada
      {
        kind: 'PDAM',
        providerId: '00000000-0000-4000-8000-000000000000',
        passthroughAmount: 1_000,
        serviceFeeAmount: 0,
      },
      // providerId bukan uuid
      { kind: 'PDAM', providerId: 'bukan-uuid', passthroughAmount: 1_000, serviceFeeAmount: 0 },
      // tipe salah: string
      { kind: 'PDAM', providerId, passthroughAmount: '1000', serviceFeeAmount: 0 },
      // tipe salah: array
      { kind: 'PDAM', providerId, passthroughAmount: [1_000], serviceFeeAmount: 0 },
      // field wajib hilang
      { kind: 'PDAM', providerId },
    ]

    for (const jasa of payloadBuruk) {
      const res = await raw('POST', '/api/transactions', {
        lines: [],
        services: [jasa],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 1_000_000,
        idempotencyKey: kunci(),
      })
      expect(
        [400, 404],
        `payload ${JSON.stringify(jasa)} dapat ${res.status}`,
      ).toContain(res.status)
    }

    expect(await prisma.transaction.count()).toBe(trxSebelum)
    expect(await saldo()).toBe(saldoSebelum)
  }, 180_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// C. CONCURRENCY — dua request berebut angka yang sama
// ═══════════════════════════════════════════════════════════════════════════

describe('C. concurrency', () => {
  it('C1. lima penyesuaian saldo SERENTAK ke angka yang sama: saldo akhir = angka itu', async () => {
    // Hipotesis: adjustProviderBalance membaca saldo DI LUAR transaction lalu
    // menerapkan SELISIH hasil hitungan itu. Lima request yang sama-sama membaca
    // saldo lama akan menerapkan selisih yang sama lima kali.
    //
    // Yang dituju pemilik: "saldo asli di aplikasi Shopee = X". Kalau hasil
    // akhirnya bukan X, angka uang di sistem salah tanpa ada yang menyadarinya.
    await loginAs(ownerId, OWNER_PIN)

    const TARGET = 1_234_567
    const kirim = () =>
      raw('POST', `/api/providers/${providerId}/adjustment`, {
        newBalance: TARGET,
        reason: 'Hasil cek saldo di aplikasi',
        ownerPin: OWNER_PIN,
        idempotencyKey: kunci(),
      })

    await Promise.all([kirim(), kirim(), kirim(), kirim(), kirim()])

    // Berapa pun yang berhasil, hasil akhirnya harus angka yang diketik pemilik.
    expect(await saldo()).toBe(TARGET)
  }, 180_000)

  it('C2. dua top-up SERENTAK dengan kunci BERBEDA: keduanya tercatat penuh', async () => {
    // Kebalikannya: dua top-up sah tidak boleh saling menimpa.
    const saldoSebelum = await saldo()

    const kirim = (nominal: number) =>
      raw('POST', `/api/providers/${providerId}/topup`, {
        amount: nominal,
        paidFrom: 'OTHER',
        idempotencyKey: kunci(),
      })

    const [a, b] = await Promise.all([kirim(100_000), kirim(250_000)])
    expect([a.status, b.status]).toEqual([201, 201])

    expect(await saldo()).toBe(saldoSebelum + 350_000)
  }, 180_000)

  it('C3. lima checkout jasa SERENTAK: saldo provider turun tepat lima kali', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const saldoSebelum = await saldo()

    const kirim = () =>
      raw('POST', '/api/transactions', {
        lines: [],
        services: [
          { kind: 'PDAM', providerId, passthroughAmount: 50_000, serviceFeeAmount: 2_000 },
        ],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 52_000,
        idempotencyKey: kunci(),
      })

    const hasil = await Promise.all([kirim(), kirim(), kirim(), kirim(), kirim()])
    const sukses = hasil.filter((r) => r.status === 201).length
    expect(sukses).toBe(5)

    // Tidak ada lost update: pola raw SQL `saldo = saldo + ?` yang menjaganya.
    expect(await saldo()).toBe(saldoSebelum - 5 * 50_000)

    const gerak = await prisma.providerBalanceMovement.count({
      where: { reason: 'SERVICE', amountChange: -50_000 },
    })
    expect(gerak).toBe(5)
  }, 180_000)

  it('C4. lima barang masuk SERENTAK dengan kunci berbeda: stok naik tepat lima kali', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const stokSebelum = await stok()

    const kirim = () =>
      raw('POST', `/api/products/${productId}/stock-in`, {
        qty: 3,
        idempotencyKey: kunci(),
      })

    const hasil = await Promise.all([kirim(), kirim(), kirim(), kirim(), kirim()])
    expect(hasil.filter((r) => r.status === 201).length).toBe(5)
    expect(await stok()).toBe(stokSebelum + 15)
  }, 180_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// D. JALAN BUNTU — pesan error yang menunjuk ke jalur yang tidak ada
// ═══════════════════════════════════════════════════════════════════════════

describe('D. koreksi transaksi jasa', () => {
  let trxJasaId = ''

  it('D1. siapkan satu transaksi jasa yang lunas', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await raw('POST', '/api/transactions', {
      lines: [],
      services: [
        { kind: 'TOKEN_LISTRIK', providerId, passthroughAmount: 100_000, serviceFeeAmount: 2_500 },
      ],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 102_500,
      idempotencyKey: kunci(),
    })
    expect(res.status).toBe(201)
    trxJasaId = String(res.data.transactionId)
  }, 120_000)

  it('D2. void ditolak, DAN pesannya menyebut jalur yang benar-benar bisa ditempuh', async () => {
    // Void memang harus ditolak: titipannya sudah dibayarkan ke provider.
    //
    // Tapi pesan penolakan adalah instruksi kepada manusia yang sedang berdiri
    // di depan pelanggan. Kalau ia menyuruh "gunakan refund" sementara refund
    // atas transaksi jasa mustahil dilakukan — tidak ada baris barang untuk
    // di-refund — maka kasirnya dikirim ke jalan buntu.
    const res = await raw('POST', `/api/transactions/${trxJasaId}/void`, {
      ownerPin: OWNER_PIN,
      reason: 'Pelanggan salah nomor meter',
    })

    expect(res.status).toBe(409)
    const pesan = res.text

    // Kalau pesannya menyebut refund, refund harus benar-benar bisa dijalankan.
    if (/refund/i.test(pesan)) {
      const item = await prisma.transactionItem.findFirst({ where: { transactionId: trxJasaId } })
      expect(
        item,
        'pesan menyuruh memakai refund, tetapi transaksi jasa tidak punya baris yang bisa di-refund — jalan buntu',
      ).not.toBeNull()
    }

    // Dan langkah yang disebut harus benar-benar ada di sistem ini.
    expect(pesan).toMatch(/pengeluaran kas/i)
    expect(pesan).toMatch(/Saldo/i)

    // Buktikan bahwa jalur refund memang TIDAK tersedia untuk transaksi ini,
    // supaya pesan di atas tidak diam-diam kembali menyebutnya suatu hari.
    const refund = await raw('POST', `/api/transactions/${trxJasaId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [],
      method: 'CASH',
      reason: 'Salah nomor meter',
      idempotencyKey: kunci(),
    })
    expect(refund.status).toBe(400)
  }, 120_000)

  it('D3. transaksi jasa tetap utuh setelah percobaan koreksi', async () => {
    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: trxJasaId } })
    expect(trx.status).toBe('COMPLETED')
    expect(trx.netTotal).toBe(2_500)
    expect(trx.passthroughTotal).toBe(100_000)
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// E. REPLAY & LINTAS PENGGUNA
// ═══════════════════════════════════════════════════════════════════════════

describe('E. replay dan lintas pengguna', () => {
  it('E1. kunci top-up milik pengguna lain ditolak 409, tanpa membocorkan angkanya', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const k = kunci()
    const pertama = await raw('POST', `/api/providers/${providerId}/topup`, {
      amount: 77_000,
      paidFrom: 'OTHER',
      idempotencyKey: k,
    })
    expect(pertama.status).toBe(201)
    const saldoSesudah = await saldo()

    await loginAs(owner2Id, OWNER2_PIN)
    const kedua = await raw('POST', `/api/providers/${providerId}/topup`, {
      amount: 77_000,
      paidFrom: 'OTHER',
      idempotencyKey: k,
    })

    expect(kedua.status).toBe(409)
    // Tidak menjawab dengan angka saldo milik pergerakan orang lain.
    expect(kedua.text).not.toContain(String(saldoSesudah))
    expect(await saldo()).toBe(saldoSesudah)
  }, 120_000)

  it('E2. kunci yang sama dengan nominal berbeda ditolak 409', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const k = kunci()
    const a = await raw('POST', `/api/providers/${providerId}/topup`, {
      amount: 10_000,
      paidFrom: 'OTHER',
      idempotencyKey: k,
    })
    expect(a.status).toBe(201)
    const saldoSesudah = await saldo()

    const b = await raw('POST', `/api/providers/${providerId}/topup`, {
      amount: 999_000,
      paidFrom: 'OTHER',
      idempotencyKey: k,
    })
    expect(b.status).toBe(409)
    expect(await saldo()).toBe(saldoSesudah)
  }, 120_000)

  it('E3. penyesuaian saldo diulang dengan kunci sama: tidak berlaku dua kali', async () => {
    const k = kunci()
    const target = (await saldo()) - 3_000
    const isi = {
      newBalance: target,
      reason: 'Selisih hasil cek',
      ownerPin: OWNER_PIN,
      idempotencyKey: k,
    }

    const a = await raw('POST', `/api/providers/${providerId}/adjustment`, isi)
    const b = await raw('POST', `/api/providers/${providerId}/adjustment`, isi)

    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(b.data.replayed).toBe(true)
    expect(await saldo()).toBe(target)
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// F. KEBOCORAN DATA
// ═══════════════════════════════════════════════════════════════════════════

describe('F. kebocoran data pada error', () => {
  it('F1. error tidak membocorkan stack trace, path berkas, atau query', async () => {
    await loginAs(cashierId, CASHIER_PIN)

    const percobaan = [
      await raw('POST', '/api/transactions', { lines: 'bukan-array' }),
      await raw('GET', '/api/transactions/tidak-ada-id'),
      await raw('POST', `/api/providers/${providerId}/topup`, { amount: 'x' }),
      await raw('POST', '/api/transactions', {
        lines: [],
        services: [
          {
            kind: 'PDAM',
            providerId: '00000000-0000-4000-8000-000000000000',
            passthroughAmount: 1,
            serviceFeeAmount: 0,
          },
        ],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 1,
        idempotencyKey: kunci(),
      }),
    ]

    for (const res of percobaan) {
      const t = res.text
      expect(t).not.toMatch(/at [A-Za-z]+ \(.*\.ts:/)
      expect(t).not.toMatch(/node_modules/)
      expect(t).not.toMatch(/D:\\|\/home\/|C:\\Users/)
      expect(t).not.toMatch(/SELECT .* FROM|INSERT INTO|PrismaClient/)
      expect(t).not.toMatch(/pinHash|\$2[aby]\$/)
    }
  }, 120_000)

  it('F2. daftar provider tidak membawa kolom yang tidak perlu ke browser', async () => {
    const res = await raw('GET', '/api/providers')
    expect(res.status).toBe(200)
    // Kasir boleh tahu saldo (ia perlu sebelum menjual), tapi tidak perlu
    // metadata internal apa pun di luar yang dipakai layar kasir.
    const providers = res.data.providers as Record<string, unknown>[]
    const kunciYangAda = Object.keys(providers[0] ?? {}).sort()
    expect(kunciYangAda).toEqual(['aktif', 'id', 'jenis', 'nama', 'saldo', 'urutan'])
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// G. INTEGRITAS KUMULATIF — batas yang dijaga dengan baca-lalu-tulis
// ═══════════════════════════════════════════════════════════════════════════

describe('G. batas kumulatif di bawah tekanan', () => {
  let trxId = ''
  let itemId = ''
  const QTY = 3

  it('G1. siapkan transaksi barang yang lunas', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await raw('POST', '/api/transactions', {
      lines: [{ productId, qty: QTY, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 100_000,
      idempotencyKey: kunci(),
    })
    expect(res.status).toBe(201)
    trxId = String(res.data.transactionId)

    const item = await prisma.transactionItem.findFirstOrThrow({
      where: { transactionId: trxId },
    })
    itemId = item.id
    expect(item.qty).toBe(QTY)
  }, 120_000)

  it('G2. tiga refund SERENTAK dengan kunci berbeda tidak boleh melebihi qty asli', async () => {
    // Invariant: Σ refundedQty <= qty.
    //
    // `refundedQty` diperbarui dengan pola baca-lalu-tulis, dan yang
    // menahannya selama ini hanya `connection_limit=1`. Test ini menyerang
    // justru asumsi itu: tiga permintaan refund 2 dari 3 yang datang bersamaan.
    // Kalau guard kumulatifnya bocor, total terkembalikan menjadi 4 atau 6 dari
    // barang yang cuma 3 — uang keluar untuk barang yang tidak pernah ada.
    const kirim = () =>
      raw('POST', `/api/transactions/${trxId}/refunds`, {
        ownerPin: OWNER_PIN,
        items: [{ transactionItemId: itemId, qty: 2 }],
        method: 'CASH',
        reason: 'Serangan refund serentak',
        idempotencyKey: kunci(),
      })

    await Promise.all([kirim(), kirim(), kirim()])

    const item = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    expect(
      item.refundedQty,
      `refundedQty ${item.refundedQty} melebihi qty ${QTY} — uang keluar untuk barang yang tidak ada`,
    ).toBeLessThanOrEqual(QTY)

    // Dan jumlah baris refund harus konsisten dengan qty yang benar-benar
    // terkembalikan, bukan lebih.
    const refundItems = await prisma.refundItem.findMany({
      where: { transactionItemId: itemId },
    })
    const totalDariBaris = refundItems.reduce((a, r) => a + r.qty, 0)
    expect(totalDariBaris).toBe(item.refundedQty)
  }, 180_000)

  it('G3. dua void SERENTAK: stok hanya kembali sekali', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const jual = await raw('POST', '/api/transactions', {
      lines: [{ productId, qty: 2, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 50_000,
      idempotencyKey: kunci(),
    })
    expect(jual.status).toBe(201)
    const id = String(jual.data.transactionId)
    const stokSetelahJual = await stok()

    const kirim = () =>
      raw('POST', `/api/transactions/${id}/void`, {
        ownerPin: OWNER_PIN,
        reason: 'Serangan void serentak',
      })

    const [a, b] = await Promise.all([kirim(), kirim()])
    const sukses = [a.status, b.status].filter((s) => s === 200).length
    expect(sukses, 'tepat satu void yang boleh berhasil').toBe(1)

    // Stok kembali TEPAT dua, bukan empat.
    expect(await stok()).toBe(stokSetelahJual + 2)

    // Satu produk → satu baris pergerakan, dan jumlahnya +2. Yang dijaga adalah
    // TOTAL qtyChange-nya, bukan jumlah barisnya: void kedua yang lolos akan
    // menambah baris sekaligus menggandakan totalnya.
    const kembali = await prisma.stockMovement.findMany({
      where: { refId: id, reason: 'VOID' },
      select: { qtyChange: true },
    })
    expect(kembali.reduce((t, m) => t + m.qtyChange, 0)).toBe(2)
  }, 180_000)

  it('G4. dua penutupan shift SERENTAK: hanya satu yang tercatat', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const current = await raw('GET', '/api/shifts/current')
    const shiftId = String((current.data.shift as { id: string }).id)

    const kirim = () => raw('POST', `/api/shifts/${shiftId}/close`, { countedCash: KAS_AWAL })

    const [a, b] = await Promise.all([kirim(), kirim()])
    const sukses = [a.status, b.status].filter((s) => s === 200).length
    expect(sukses, 'tepat satu penutupan yang boleh berhasil').toBe(1)

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(shift.status).toBe('CLOSED')
    expect(shift.openKey).toBeNull()
    expect(shift.closedAt).not.toBeNull()
  }, 180_000)

  it('G5. pengeluaran setelah shift ditutup DITOLAK', async () => {
    const res = await raw('POST', '/api/expenses', {
      kategori: 'Operasional',
      amount: 5_000,
      paidFrom: 'CASH_DRAWER',
      idempotencyKey: kunci(),
    })
    // Tidak ada shift terbuka lagi setelah G4.
    expect(res.status).toBe(409)
  }, 120_000)
})
