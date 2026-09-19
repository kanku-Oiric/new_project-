import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test lewat HTTP, terhadap server Next.js yang BENAR-BENAR
 * berjalan.
 *
 * Kenapa seberat ini, padahal sudah ada test yang memanggil fungsi checkout
 * langsung: test yang memanggil fungsi tidak pernah menyentuh bundler. Fase 2
 * lolos test + typecheck + lint + build, tapi setiap route mengembalikan 500 di
 * runtime, karena `instrumentation.ts` dikompilasi untuk runtime non-Node dan
 * webpack gagal meresolusi `node:crypto` serta `crypto` milik bcryptjs. Tidak
 * satu pun pemeriksaan itu bisa melihatnya.
 *
 * Yang bisa melihatnya hanyalah request sungguhan ke server sungguhan. Test ini
 * sengaja memakai `next dev` karena di situlah kerusakan muncul, dan karena ia
 * mengompilasi route saat diminta — persis seperti yang dialami kasir.
 */

const PIN = '111213'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let dbPath = ''
let cashierId = ''
let productId = ''
let cookie = ''

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

async function waitForServer(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'tidak pernah menjawab'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      // Server hidup. Statusnya sendiri yang diperiksa test, bukan di sini —
      // 500 pun berarti server siap menjawab dan test boleh menilainya.
      return res
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`server tidak siap dalam ${timeoutMs}ms: ${lastError}`)
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-http-'))
  dbPath = path.join(tmpDir, 'http.db')
  const dbUrl = `file:${dbPath}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const cashier = await prisma.user.create({
    data: {
      name: 'Kasir HTTP',
      role: 'CASHIER',
      pinHash: await bcrypt.hash(PIN, 10),
    },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'HTTP-001',
      barcode: '9990000000001',
      nama: 'Produk HTTP',
      searchKey: 'produk http http-001 9990000000001',
      kategori: 'Uji',
      hargaJual: 4_000,
      hargaBeli: 2_800,
      stok: 50,
      stokMinimum: 5,
    },
  })
  productId = product.id

  for (const [key, value] of Object.entries({ storeName: 'Toko Uji', timezone: 'Asia/Jakarta' })) {
    await prisma.setting.create({ data: { key, value } })
  }

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`

  server = spawn(
    process.execPath,
    [path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // DATABASE_URL di process.env menang atas .env — Next tidak menimpa
        // variabel yang sudah ada.
        DATABASE_URL: dbUrl,
        NODE_ENV: 'development',
        // Folder build terpisah. Tanpa ini, `next dev` milik test menulis ke
        // `.next` yang sama dengan dev server yang mungkin sedang dipakai orang
        // lain, lalu isinya tercampur dengan output `next build` dan halaman
        // gagal dengan "Cannot find module './vendor-chunks/...'".
        NEXT_DIST_DIR: '.next-test',
      },
      stdio: 'pipe',
    },
  )

  server.stderr?.on('data', () => {
    // Dibiarkan mengalir tanpa mencetak; kegagalan sebenarnya muncul sebagai
    // status HTTP di assertion, yang jauh lebih jelas dibaca.
  })

  await waitForServer(`${baseUrl}/api/health`, 120_000)
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect()
  if (server?.pid) {
    if (process.platform === 'win32') {
      // child.kill() hanya mematikan proses pembungkus; `next dev` menurunkan
      // proses anak yang tetap memegang port kalau tidak dimatikan sepohon.
      try {
        execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'pipe' })
      } catch {
        // Proses mungkin sudah mati lebih dulu; bukan kegagalan test.
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

describe('server benar-benar melayani request', () => {
  it('GET /api/health menjawab 200 — kanari untuk module graph yang rusak', async () => {
    // Test inilah yang akan menangkap kegagalan bundling seperti bcryptjs
    // tertarik ke runtime tanpa `crypto`: saat itu terjadi, SELURUH route
    // menjawab 500, termasuk yang tidak memakai modul bermasalah.
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { ok: boolean; database: { ok: boolean } }
    expect(body.ok).toBe(true)
    expect(body.database.ok).toBe(true)
  }, 120_000)

  it('route menjawab JSON, bukan halaman HTML error', async () => {
    const res = await fetch(`${baseUrl}/api/users`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
  }, 60_000)
})

describe('POST /api/transactions lewat HTTP', () => {
  it('menolak tanpa login', async () => {
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lines: [{ productId, qty: 1, itemDiscount: 0 }],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 10_000,
      }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  }, 60_000)

  it('login PIN berhasil dan mengembalikan cookie session', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: cashierId, pin: PIN }),
    })
    expect(res.status).toBe(200)

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('kasir_session=')
    expect(setCookie).toContain('HttpOnly')
    cookie = setCookie?.split(';')[0] ?? ''
    expect(cookie).not.toBe('')
  }, 60_000)

  it('checkout tunai menjawab 201, transaksi tersimpan, stok berkurang', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } })

    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        lines: [{ productId, qty: 3, itemDiscount: 500 }],
        transactionDiscount: 1_000,
        method: 'CASH',
        amountTendered: 20_000,
      }),
    })

    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toContain('application/json')

    const body = (await res.json()) as {
      transactionId: string
      trxNumber: string
      status: string
      netTotal: number
      changeAmount: number
    }

    // 3 × 4.000 = 12.000; −500 diskon item; −1.000 diskon transaksi = 10.500
    expect(body.netTotal).toBe(10_500)
    expect(body.changeAmount).toBe(9_500)
    expect(body.status).toBe('COMPLETED')
    expect(body.trxNumber).toMatch(/^TRX-\d{8}-\d{6}$/)

    // Tersimpan di database, bukan cuma dijawab.
    const saved = await prisma.transaction.findUniqueOrThrow({
      where: { id: body.transactionId },
      include: { items: true, payments: true },
    })
    expect(saved.status).toBe('COMPLETED')
    expect(saved.netTotal).toBe(10_500)
    expect(saved.cogsTotal).toBe(8_400)
    expect(saved.items).toHaveLength(1)
    expect(saved.items[0]?.lineFinal).toBe(10_500)
    expect(saved.payments[0]?.status).toBe('PAID')
    expect(saved.payments[0]?.changeAmount).toBe(9_500)

    // Stok berkurang, dengan jejaknya.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(after.stok).toBe(before.stok - 3)

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { refId: body.transactionId },
    })
    expect(movement.qtyChange).toBe(-3)
    expect(movement.reason).toBe('SALE')
    expect(movement.stockBefore).toBe(before.stok)
    expect(movement.stockAfter).toBe(before.stok - 3)
  }, 90_000)

  it('input tidak valid menjawab 400 dengan envelope JSON, bukan 500', async () => {
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        lines: [],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 10_000,
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION')
  }, 60_000)

  it('uang tunai kurang ditolak tanpa menyentuh stok', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } })

    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        lines: [{ productId, qty: 2, itemDiscount: 0 }],
        transactionDiscount: 0,
        method: 'CASH',
        amountTendered: 1_000,
      }),
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)

    const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(after.stok).toBe(before.stok)
  }, 60_000)

  it('lookup barcode lewat HTTP mengembalikan produk yang tepat', async () => {
    const res = await fetch(`${baseUrl}/api/products/lookup?barcode=9990000000001`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { product: { id: string; nama: string } }
    expect(body.product.id).toBe(productId)
    expect(body.product.nama).toBe('Produk HTTP')
  }, 60_000)

  it('barcode tidak dikenal menjawab 404, bukan menambah barang yang salah', async () => {
    const res = await fetch(`${baseUrl}/api/products/lookup?barcode=0000000000000`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(404)
  }, 60_000)
})
