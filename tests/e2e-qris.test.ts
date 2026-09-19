import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * End-to-end QRIS statis lewat HTTP: unggah QR → aktifkan → checkout → dua
 * konfirmasi bersamaan → pembatalan → tutup shift.
 *
 * Alasan test ini ada di lapisan HTTP, bukan cukup di lapisan service: Fase 2
 * lolos test + typecheck + lint + build sementara checkout menjawab 500 di
 * runtime, karena tidak satu pun pemeriksaan itu memuat route handler lewat
 * bundler Next. Untuk QRIS, jalur yang paling mahal kalau salah justru
 * konfirmasi — di situlah stok berkurang dan uang dianggap masuk.
 *
 * Yang diperiksa di sini dan tidak bisa dilihat lapisan lain:
 *  - tidak ada yang menjadi PAID tanpa request konfirmasi (dibuktikan dengan
 *    menunggu, lalu memeriksa ulang),
 *  - dua konfirmasi bersamaan lewat HTTP: satu 200, satu 409, stok sekali,
 *  - session wajib: tanpa cookie, konfirmasi ditolak 401,
 *  - transaksi PENDING yang ditinggalkan tidak memblokir penutupan shift.
 */

const OWNER_PIN = '314159'
const CASHIER_PIN = '271828'

/** PNG 1x1 — cukup untuk menguji sniffing, unggahan, dan penyajian berkas. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let uploadsDir = ''
let ownerId = ''
let cashierId = ''
let productId = ''
let ownerCookie = ''
let cashierCookie = ''

const HARGA_JUAL = 15_000
const HARGA_BELI = 11_000
const STOK_AWAL = 30
const QTY = 2
const KAS_AWAL = 150_000

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
  cookie = cashierCookie,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-qris-e2e-'))
  uploadsDir = path.join(tmpDir, 'uploads')
  const dbUrl = `file:${path.join(tmpDir, 'qris.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const owner = await prisma.user.create({
    data: { name: 'Pemilik QRIS', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  ownerId = owner.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir QRIS', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'QR-001',
      barcode: '7771111111111',
      nama: 'Gula Pasir 1kg',
      searchKey: 'gula pasir 1kg qr-001',
      kategori: 'Uji',
      hargaJual: HARGA_JUAL,
      hargaBeli: HARGA_BELI,
      stok: STOK_AWAL,
      stokMinimum: 5,
    },
  })
  productId = product.id

  // Sengaja TIDAK menulis qrisEnabled/qrisImagePath: keadaan awal toko baru
  // adalah QRIS belum dikonfigurasi, dan itu yang diuji lebih dulu.
  for (const [key, value] of Object.entries({
    storeName: 'Toko QRIS',
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
        // Folder build sendiri, supaya test ini tidak merusak dev server yang
        // mungkin sedang dipakai orang, maupun test HTTP lainnya.
        NEXT_DIST_DIR: '.next-qris',
        // Gambar unggahan masuk ke folder temp, bukan ke data/uploads toko.
        UPLOADS_DIR: uploadsDir,
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

describe('QRIS statis lewat HTTP', () => {
  let shiftId = ''
  let paymentId = ''
  let transactionId = ''
  let qrImageName = ''

  it('1. server hidup dan menjawab', async () => {
    // Kanari: kalau module graph rusak, SEMUA route menjawab 500 sekaligus dan
    // satu assertion ini langsung menangkapnya.
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
  }, 120_000)

  it('2. QRIS ditolak selama belum dikonfigurasi, dan tidak ada transaksi tersisa', async () => {
    cashierCookie = await login(cashierId, CASHIER_PIN)
    const opened = await api('POST', '/api/shifts/open', { openingCash: KAS_AWAL })
    expect(opened.status).toBe(201)
    shiftId = String(opened.data.shiftId)

    const checkout = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: QTY, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
    })

    // 400, bukan 503: tidak ada yang tertulis, dan tindakan yang benar bagi kasir
    // adalah beralih ke tunai.
    expect(checkout.status).toBe(400)
    expect(JSON.stringify(checkout.data)).toMatch(/belum dikonfigurasi/i)

    expect(await prisma.transaction.count()).toBe(0)
    expect(await prisma.payment.count()).toBe(0)
  }, 60_000)

  it('3. QRIS tidak bisa dinyalakan tanpa gambar QR', async () => {
    ownerCookie = await login(ownerId, OWNER_PIN)

    const res = await api(
      'PATCH',
      '/api/settings',
      { ownerPin: OWNER_PIN, values: { qrisEnabled: 'true' } },
      ownerCookie,
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/gambar QR/i)

    const row = await prisma.setting.findUnique({ where: { key: 'qrisEnabled' } })
    expect(row?.value ?? 'false').toBe('false')
  }, 60_000)

  it('4. kasir tidak boleh mengubah pengaturan, walau PIN pemiliknya benar', async () => {
    const res = await api(
      'PATCH',
      '/api/settings',
      { ownerPin: OWNER_PIN, values: { qrisEnabled: 'true' } },
      cashierCookie,
    )
    // Role dicek server sebelum apa pun. Menyembunyikan menu bukan otorisasi.
    expect(res.status).toBe(403)
  }, 60_000)

  it('5. unggah gambar QR menolak berkas yang bukan gambar', async () => {
    const form = new FormData()
    form.set('ownerPin', OWNER_PIN)
    form.set('file', new Blob([Buffer.from('<svg/>')], { type: 'image/png' }), 'palsu.png')

    const res = await fetch(`${baseUrl}/api/settings/qris-image`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
      body: form,
    })
    expect(res.status).toBe(400)

    // Tipe ditentukan dari isi berkas, bukan dari nama atau content-type yang
    // dikirim browser — keduanya bisa dikarang siapa pun di WiFi toko.
    const body = (await res.json()) as Record<string, unknown>
    expect(JSON.stringify(body)).toMatch(/PNG, JPG, atau WEBP/i)
  }, 60_000)

  it('6. unggah gambar QR yang sah, lalu bisa dibaca kembali lewat route', async () => {
    const form = new FormData()
    form.set('ownerPin', OWNER_PIN)
    form.set('file', new Blob([PNG_1X1], { type: 'image/png' }), 'qris-toko.png')

    const res = await fetch(`${baseUrl}/api/settings/qris-image`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
      body: form,
    })
    expect(res.status).toBe(201)
    const uploaded = (await res.json()) as { qrisImagePath: string }
    qrImageName = uploaded.qrisImagePath
    expect(qrImageName).toMatch(/^qris-\d{8}-\d{6}\.png$/)

    // Yang tersimpan di setting hanya NAMA berkasnya, bukan path.
    const setting = await prisma.setting.findUniqueOrThrow({ where: { key: 'qrisImagePath' } })
    expect(setting.value).toBe(qrImageName)
    expect(fs.existsSync(path.join(uploadsDir, qrImageName))).toBe(true)

    const image = await fetch(`${baseUrl}/api/uploads/${qrImageName}`, {
      headers: { Cookie: cashierCookie },
    })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
  }, 60_000)

  it('7. gambar unggahan butuh login, dan tidak bisa dipakai keluar dari folder uploads', async () => {
    const anon = await fetch(`${baseUrl}/api/uploads/${qrImageName}`)
    expect(anon.status).toBe(401)

    for (const attempt of ['..%2Fpos.db', '..%5Cpos.db', 'pos.db']) {
      const res = await fetch(`${baseUrl}/api/uploads/${attempt}`, {
        headers: { Cookie: cashierCookie },
      })
      expect([400, 404]).toContain(res.status)
    }
  }, 60_000)

  it('8. aktifkan QRIS, tercatat di audit log', async () => {
    const res = await api(
      'PATCH',
      '/api/settings',
      { ownerPin: OWNER_PIN, values: { qrisEnabled: 'true' } },
      ownerCookie,
    )
    expect(res.status).toBe(200)
    expect(res.data.changed).toEqual(['qrisEnabled'])

    const audits = await prisma.auditLog.findMany({ where: { action: 'SETTING_CHANGE' } })
    // Dua: unggah gambar, lalu penyalaan.
    expect(audits.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('9. checkout QRIS berhenti di PENDING, stok BELUM berkurang', async () => {
    const checkout = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: QTY, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
    })
    expect(checkout.status).toBe(201)
    expect(checkout.data.status).toBe('PENDING')

    paymentId = String(checkout.data.paymentId)
    transactionId = String(checkout.data.transactionId)
    expect(paymentId).not.toBe('')
    expect(checkout.data.netTotal).toBe(HARGA_JUAL * QTY)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(STOK_AWAL)
    expect(await prisma.stockMovement.count()).toBe(0)
  }, 60_000)

  it('10. menunggu tanpa menekan apa pun: tetap PENDING, tidak ada timer yang melunaskan', async () => {
    const first = await api('GET', `/api/payments/${paymentId}/status`)
    expect(first.status).toBe(200)
    expect(first.data.status).toBe('PENDING')

    // Larangan pertama docs/qris.md §3.2, diuji dengan cara yang paling langsung:
    // tidak melakukan apa pun, lalu memeriksa ulang.
    await new Promise((r) => setTimeout(r, 3_000))

    const later = await api('GET', `/api/payments/${paymentId}/status`)
    expect(later.data.status).toBe('PENDING')
    expect(later.data.transactionStatus).toBe('PENDING')

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.status).toBe('PENDING')
    expect(payment.paidAt).toBeNull()
    expect(await prisma.stockMovement.count()).toBe(0)
  }, 60_000)

  it('11. konfirmasi tanpa session ditolak 401 — PAID butuh orang yang dikenal', async () => {
    const res = await fetch(`${baseUrl}/api/payments/${paymentId}/confirm`, { method: 'POST' })
    expect(res.status).toBe(401)

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.status).toBe('PENDING')
  }, 60_000)

  it('12. dua konfirmasi bersamaan: satu 200, satu 409, stok berkurang sekali', async () => {
    const [a, b] = await Promise.all([
      api('POST', `/api/payments/${paymentId}/confirm`, {}),
      api('POST', `/api/payments/${paymentId}/confirm`, {}),
    ])

    const statuses = [a.status, b.status].sort((x, y) => x - y)
    expect(statuses).toEqual([200, 409])

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.status).toBe('PAID')
    expect(payment.confirmedByUserId).toBe(cashierId)
    expect(payment.paidAt).not.toBeNull()

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(trx.status).toBe('COMPLETED')

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(STOK_AWAL - QTY)

    const movements = await prisma.stockMovement.findMany({ where: { refId: transactionId } })
    expect(movements).toHaveLength(1)
    expect(movements[0]?.reason).toBe('SALE')

    const audits = await prisma.auditLog.findMany({
      where: { action: 'PAYMENT_CONFIRM', entityId: transactionId },
    })
    expect(audits).toHaveLength(1)
  }, 60_000)

  it('13. konfirmasi ketiga 409, pembatalan yang sudah lunas juga 409', async () => {
    const again = await api('POST', `/api/payments/${paymentId}/confirm`, {})
    expect(again.status).toBe(409)
    expect(JSON.stringify(again.data)).toMatch(/sudah dikonfirmasi/i)

    const cancel = await api('POST', `/api/payments/${paymentId}/cancel`, { reason: 'Salah tekan' })
    expect(cancel.status).toBe(409)
    expect(JSON.stringify(cancel.data)).toMatch(/void atau refund/i)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(STOK_AWAL - QTY)
  }, 60_000)

  it('14. transaksi QRIS kedua dibatalkan kasir: CANCELLED, tanpa jejak stok', async () => {
    const checkout = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
    })
    expect(checkout.status).toBe(201)
    const secondPayment = String(checkout.data.paymentId)
    const secondTrx = String(checkout.data.transactionId)

    const cancel = await api('POST', `/api/payments/${secondPayment}/cancel`, {
      reason: 'Pelanggan berubah pikiran',
    })
    expect(cancel.status).toBe(200)

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: secondTrx } })
    expect(trx.status).toBe('CANCELLED')

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: secondPayment } })
    expect(payment.status).toBe('CANCELLED')

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(STOK_AWAL - QTY)
    expect(await prisma.stockMovement.count()).toBe(1)

    const revive = await api('POST', `/api/payments/${secondPayment}/confirm`, {})
    expect(revive.status).toBe(409)
  }, 60_000)

  it('15. transaksi PENDING terlantar tidak memblokir tutup shift', async () => {
    // Dibuat lalu ditinggalkan, persis seperti pelanggan yang keluar toko.
    const abandoned = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
    })
    expect(abandoned.status).toBe(201)
    const abandonedTrx = String(abandoned.data.transactionId)

    const closed = await api('POST', `/api/shifts/${shiftId}/close`, {
      countedCash: KAS_AWAL,
    })
    expect(closed.status).toBe(200)

    const result = closed.data as {
      cancelledPending: number
      summary: { expectedCash: number; nonCashSales: number; difference: number }
    }
    expect(result.cancelledPending).toBe(1)

    // QRIS tidak masuk laci: expectedCash tetap kas awal walaupun ada penjualan
    // QRIS yang lunas.
    expect(result.summary.expectedCash).toBe(KAS_AWAL)
    expect(result.summary.difference).toBe(0)
    expect(result.summary.nonCashSales).toBe(HARGA_JUAL * QTY)

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: abandonedTrx } })
    expect(trx.status).toBe('CANCELLED')

    const payment = await prisma.payment.findFirstOrThrow({
      where: { transactionId: abandonedTrx },
    })
    expect(payment.status).toBe('CANCELLED')

    const audits = await prisma.auditLog.findMany({
      where: { action: 'PENDING_CANCELLED_ON_SHIFT_CLOSE' },
    })
    expect(audits).toHaveLength(1)

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(shift.status).toBe('CLOSED')
    expect(shift.openKey).toBeNull()
  }, 60_000)

  it('16. setelah shift ditutup, konfirmasi transaksi yang sudah dibatalkan tetap ditolak', async () => {
    const cancelled = await prisma.transaction.findFirstOrThrow({
      where: { status: 'CANCELLED' },
      include: { payments: true },
    })
    const target = cancelled.payments[0]
    expect(target).toBeDefined()

    const res = await api('POST', `/api/payments/${target?.id}/confirm`, {})
    expect(res.status).toBe(409)
  }, 60_000)
})
