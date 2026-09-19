import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Kunci sekali-pakai, diuji lewat HTTP.
 *
 * Wajib di lapisan ini, bukan cukup di service: yang dilindungi adalah request
 * yang DIULANG oleh browser, dan pengulangan itu hanya nyata kalau melewati route
 * handler, Zod, session, dan database yang sama seperti saat toko dipakai.
 *
 * Skenario yang melatarbelakangi seluruh berkas ini (docs/architecture.md §20):
 *
 *   kasir tekan Bayar → server commit → WiFi tersendat → response hilang
 *   → kasir menyangka gagal → tekan Bayar lagi
 *
 * Tanpa kunci, langkah terakhir mencatat penjualan kedua dan menurunkan stok dua
 * kali. Test nomor 4 di bawah membuktikan bahwa itulah yang memang terjadi tanpa
 * kunci — supaya jelas bahwa yang melindungi adalah kuncinya, bukan kebetulan.
 */

const OWNER_PIN = '246810'
const CASHIER_PIN = '111213'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let cashierId = ''
let ownerId = ''
let productId = ''
let cookie = ''

const HARGA_JUAL = 12_000
const HARGA_BELI = 9_000
const STOK_AWAL = 50
const KAS_AWAL = 100_000

/** UUID v4 yang sah, cukup untuk dipakai sebagai kunci di test. */
function key(seed: string): string {
  const hex = seed.padEnd(32, '0').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
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

async function api(
  method: string,
  pathname: string,
  body?: unknown,
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

async function loginAs(userId: string, pin: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin }),
  })
  expect(res.status).toBe(200)
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  expect(cookie).not.toBe('')
}

async function stok(): Promise<number> {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
  return p.stok
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-idem-'))
  const dbUrl = `file:${path.join(tmpDir, 'idem.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const owner = await prisma.user.create({
    data: { name: 'Pemilik Idem', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  ownerId = owner.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir Idem', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'IDEM-001',
      barcode: '7770000000009',
      nama: 'Produk Idem',
      searchKey: 'produk idem idem-001',
      kategori: 'Uji',
      hargaJual: HARGA_JUAL,
      hargaBeli: HARGA_BELI,
      stok: STOK_AWAL,
      stokMinimum: 5,
    },
  })
  productId = product.id

  for (const [k, value] of Object.entries({
    storeName: 'Toko Idem',
    timezone: 'Asia/Jakarta',
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
        // Folder build sendiri, supaya test ini tidak merusak server dev yang
        // mungkin sedang dipakai orang (docs/architecture.md §18.1).
        NEXT_DIST_DIR: '.next-idem',
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

describe('kunci sekali-pakai pada checkout', () => {
  const K1 = key('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1')
  const K2 = key('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2')
  const KEY_LAIN = key('c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3')

  const keranjang = {
    lines: [{ productId: '', qty: 2, itemDiscount: 0 }],
    transactionDiscount: 0,
    method: 'CASH' as const,
    amountTendered: 50_000,
  }

  let trxNumberPertama = ''

  it('1. checkout pertama membuat transaksi (201)', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const shift = await api('POST', '/api/shifts/open', { openingCash: KAS_AWAL })
    expect(shift.status).toBe(201)

    const res = await api('POST', '/api/transactions', {
      ...keranjang,
      lines: [{ productId, qty: 2, itemDiscount: 0 }],
      idempotencyKey: K1,
    })

    expect(res.status).toBe(201)
    expect(res.data.replayed).toBe(false)
    trxNumberPertama = String(res.data.trxNumber)

    expect(await stok()).toBe(STOK_AWAL - 2)
  }, 120_000)

  it('2. request KEDUA dengan kunci sama: 200, transaksi yang SAMA, stok tidak turun lagi', async () => {
    // Inilah kasus "response hilang lalu kasir menekan Bayar lagi". Sebelum ada
    // kunci, blok ini akan menghasilkan transaksi kedua dan stok 46.
    const res = await api('POST', '/api/transactions', {
      ...keranjang,
      lines: [{ productId, qty: 2, itemDiscount: 0 }],
      idempotencyKey: K1,
    })

    expect(res.status).toBe(200)
    expect(res.data.replayed).toBe(true)
    expect(res.data.trxNumber).toBe(trxNumberPertama)

    expect(await stok()).toBe(STOK_AWAL - 2)
    expect(await prisma.transaction.count()).toBe(1)
    expect(await prisma.payment.count()).toBe(1)
    // Stok bergerak SEKALI, dan riwayat stok tidak boleh menyimpan jejak kedua.
    expect(await prisma.stockMovement.count({ where: { reason: 'SALE' } })).toBe(1)
  }, 120_000)

  it('3. kunci sama dengan isi BERBEDA ditolak 409, bukan dijawab struk lain', async () => {
    // Kalau ini dijawab 200 dengan transaksi nomor 1, kasir menerima struk untuk
    // penjualan yang bukan yang ia maksud — dan tidak akan pernah tahu.
    const res = await api('POST', '/api/transactions', {
      ...keranjang,
      lines: [{ productId, qty: 5, itemDiscount: 0 }],
      idempotencyKey: K1,
    })

    expect(res.status).toBe(409)
    expect(await prisma.transaction.count()).toBe(1)
    expect(await stok()).toBe(STOK_AWAL - 2)
  }, 120_000)

  it('4. TANPA kunci, dua request identik membuat dua transaksi', async () => {
    // Bukan sekadar pelengkap: ini yang membuktikan bahwa perlindungan di test 2
    // datang dari kuncinya, bukan dari hal lain yang kebetulan menahannya.
    const tanpaKunci = {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH' as const,
      amountTendered: 20_000,
    }

    const a = await api('POST', '/api/transactions', tanpaKunci)
    const b = await api('POST', '/api/transactions', tanpaKunci)

    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(a.data.trxNumber).not.toBe(b.data.trxNumber)
    expect(await prisma.transaction.count()).toBe(3)
    expect(await stok()).toBe(STOK_AWAL - 2 - 1 - 1)
  }, 120_000)

  it('5. dua request SERENTAK dengan kunci sama: tepat satu transaksi', async () => {
    const stokSebelum = await stok()
    const body = JSON.stringify({
      lines: [{ productId, qty: 3, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 50_000,
      idempotencyKey: K2,
    })

    const kirim = () =>
      fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body,
      })

    const [r1, r2] = await Promise.all([kirim(), kirim()])
    const d1 = (await r1.json()) as Record<string, unknown>
    const d2 = (await r2.json()) as Record<string, unknown>

    // Keduanya berhasil dan menunjuk transaksi yang sama. Yang kalah membaca
    // hasil pemenang — kasir tidak pernah melihat error karena hal ini.
    expect([r1.status, r2.status].every((s) => s === 200 || s === 201)).toBe(true)
    expect(d1.trxNumber).toBe(d2.trxNumber)

    expect(await prisma.transaction.count({ where: { idempotencyKey: K2 } })).toBe(1)
    expect(await stok()).toBe(stokSebelum - 3)
  }, 120_000)

  it('6. kunci milik kasir lain ditolak 409', async () => {
    // Kunci adalah UUID, jadi menebaknya tidak praktis — tapi kalau tertebak,
    // menjawabnya berarti membocorkan transaksi kasir lain ke perangkat mana pun
    // di LAN toko.
    await loginAs(ownerId, OWNER_PIN)
    const shift = await api('POST', '/api/shifts/open', { openingCash: 0 })
    expect(shift.status).toBe(201)

    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 2, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 50_000,
      idempotencyKey: K1,
    })
    expect(res.status).toBe(409)

    // Kunci yang belum pernah dipakai tetap jalan normal bagi pemilik.
    const sah = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 20_000,
      idempotencyKey: KEY_LAIN,
    })
    expect(sah.status).toBe(201)
  }, 120_000)

  it('7. kunci yang bentuknya bukan UUID ditolak 400', async () => {
    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 20_000,
      idempotencyKey: 'bukan-uuid',
    })
    expect(res.status).toBe(400)
  }, 120_000)
})

describe('kunci sekali-pakai pada refund', () => {
  const R1 = key('d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4')
  let transactionId = ''
  let itemId = ''
  let refundNumberPertama = ''

  it('8. siapkan satu transaksi lunas milik kasir', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 4, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 100_000,
    })
    expect(res.status).toBe(201)
    transactionId = String(res.data.transactionId)

    const item = await prisma.transactionItem.findFirstOrThrow({ where: { transactionId } })
    itemId = item.id
  }, 120_000)

  it('9. refund sebagian pertama berhasil (201)', async () => {
    const res = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId: itemId, qty: 1 }],
      method: 'CASH',
      reason: 'Barang rusak',
      idempotencyKey: R1,
    })
    expect(res.status).toBe(201)
    expect(res.data.replayed).toBe(false)
    refundNumberPertama = String(res.data.refundNumber)

    const item = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    expect(item.refundedQty).toBe(1)
  }, 120_000)

  it('10. refund KEDUA dengan kunci sama: 200, tidak ada uang keluar kedua', async () => {
    // Refund sebagian yang diulang LOLOS guard kumulatif (1 dari 4, lalu 1 dari 4
    // lagi = 2 terkembalikan). Kuncilah satu-satunya yang menahannya.
    const stokSebelum = await stok()

    const res = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId: itemId, qty: 1 }],
      method: 'CASH',
      reason: 'Barang rusak',
      idempotencyKey: R1,
    })

    expect(res.status).toBe(200)
    expect(res.data.replayed).toBe(true)
    expect(res.data.refundNumber).toBe(refundNumberPertama)

    const item = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    expect(item.refundedQty).toBe(1)
    expect(await prisma.refund.count({ where: { transactionId } })).toBe(1)
    expect(await stok()).toBe(stokSebelum)
  }, 120_000)

  it('11. TANPA kunci, refund sebagian yang sama benar-benar terjadi dua kali', async () => {
    const item = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    const sebelum = item.refundedQty

    const res = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId: itemId, qty: 1 }],
      method: 'CASH',
      reason: 'Barang rusak',
    })
    expect(res.status).toBe(201)

    const sesudah = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    expect(sesudah.refundedQty).toBe(sebelum + 1)
  }, 120_000)

  it('12. kunci refund yang sama dengan isi berbeda ditolak 409', async () => {
    const jumlahSebelum = await prisma.refund.count({ where: { transactionId } })

    const res = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId: itemId, qty: 2 }],
      method: 'CASH',
      reason: 'Barang rusak',
      idempotencyKey: R1,
    })

    expect(res.status).toBe(409)
    expect(await prisma.refund.count({ where: { transactionId } })).toBe(jumlahSebelum)
  }, 120_000)
})
