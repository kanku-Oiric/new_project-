import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * End-to-end QRIS soundbox lewat HTTP: aktifkan → checkout satu langkah →
 * tutup shift.
 *
 * Berkas ini DIBALIK, bukan dihapus. Versi sebelumnya menguji alur dua langkah
 * — unggah gambar QR, tampilkan di layar, lalu kasir menekan konfirmasi setelah
 * melihat notifikasi di HP-nya. Yang berubah bukan kodenya lebih dulu,
 * melainkan tokonya: pemilik memakai QRIS soundbox, kotak yang berbunyi saat
 * pembayaran masuk, dengan QR yang sudah tertempel permanen di meja.
 *
 * Pelanggan scan QR di meja tanpa pernah melihat layar kasir. Kasir menekan
 * tombol QRIS SETELAH mendengar bunyinya — jadi pada saat ia menekan, uangnya
 * sudah masuk. Langkah kedua yang dulu ada bukan pengaman, melainkan sumber
 * transaksi terlantar saat kasir lupa menekannya.
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

/**
 * Hari usaha menurut WIB, sama seperti yang dipakai server (`toBusinessDate`).
 *
 * BUKAN tanggal UTC. Antara pukul 00:00 dan 07:00 WIB, tanggal UTC menunjuk
 * HARI KEMARIN - sehingga test yang memakainya menanyakan laporan tanggal yang
 * transaksinya tidak ada di sana, lalu gagal dengan "expected 0 to be 16500".
 *
 * Test yang merah hanya di jam-jam tertentu lebih buruk daripada tidak ada
 * test: ia mengajari orang mengabaikan warna merah.
 */
function hariUsaha(): string {
  // en-CA menghasilkan YYYY-MM-DD, format yang sama dengan kolom businessDate.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })
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

const PREFIX_KUNCI = '55555555-5555-4555-8555'

/**
 * Kunci sekali-pakai untuk request uji.
 *
 * `idempotencyKey` sekarang WAJIB di `/api/transactions` dan `/refunds`. Test di
 * berkas ini menguji alur bisnis, bukan aturan kuncinya, jadi kuncinya diisi
 * otomatis di sini — kecuali kalau test-nya menyebutkan sendiri.
 *
 * Aturan kuncinya sendiri diuji terpisah dan menyeluruh di
 * `tests/idempotency.test.ts` (tanpa kunci, kunci sama, kunci beda, payload
 * bentrok, serentak).
 */
let urutanKunciUji = 0
function kunciUji(): string {
  urutanKunciUji += 1
  return `${PREFIX_KUNCI}-${String(urutanKunciUji).padStart(12, '0')}`
}

/** Endpoint yang mewajibkan kunci. */
function butuhKunci(pathname: string): boolean {
  return pathname === '/api/transactions' || pathname.endsWith('/refunds')
}

function denganKunci(pathname: string, body: unknown): unknown {
  if (!butuhKunci(pathname) || typeof body !== 'object' || body === null) return body
  const isi = body as Record<string, unknown>
  if ('idempotencyKey' in isi) return isi
  return { ...isi, idempotencyKey: kunciUji() }
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
    ...(body === undefined ? {} : { body: JSON.stringify(denganKunci(pathname, body)) }),
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
        // Folder backup sendiri. WAJIB di setiap test yang menjalankan server:
        // tanpa ini, backup startup dan backup tutup shift menulis snapshot
        // DATABASE UJI ke folder backups/ toko, lalu memangkas backup asli untuk
        // memberi tempat. Berkasnya tidak bisa dibedakan dari backup sungguhan,
        // dan prosedur restore di README ("pilih yang paling baru") akan
        // mengembalikan database kosong berisi "Kasir E2E".
        BACKUP_DIR: path.join(tmpDir, 'backups'),
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

describe('QRIS soundbox lewat HTTP', () => {
  let shiftId = ''
  let transactionId = ''
  let paymentId = ''

  it('1. server hidup dan menjawab', async () => {
    // Kanari: kalau module graph rusak, SEMUA route menjawab 500 sekaligus dan
    // satu assertion ini langsung menangkapnya.
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
  }, 120_000)

  it('2. QRIS ditolak selama belum dinyalakan, dan tidak ada transaksi tersisa', async () => {
    cashierCookie = await login(cashierId, CASHIER_PIN)
    const opened = await api('POST', '/api/shifts/open', { openingCash: KAS_AWAL })
    expect(opened.status).toBe(201)
    shiftId = String(opened.data.shiftId)

    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: QTY, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
    })

    // 400, bukan 503: tidak ada yang tertulis ke database, dan tindakan yang
    // benar bagi kasir adalah beralih ke tunai.
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/belum dinyalakan/i)

    // Yang terpenting: tidak ada transaksi setengah jadi yang tertinggal.
    expect(await prisma.transaction.count()).toBe(0)
    expect(await prisma.payment.count()).toBe(0)
  }, 120_000)

  it('3. QRIS bisa dinyalakan TANPA gambar QR', async () => {
    // Test ini dulu berbunyi "QRIS tidak bisa dinyalakan tanpa gambar QR", dan
    // syarat itu memang benar untuk alur lama. Ia dibalik karena gambarnya
    // hilang bersama alurnya: QR soundbox tertempel di meja dan tidak pernah
    // ditampilkan di layar siapa pun, jadi tidak ada berkas yang bisa diunggah
    // maupun diperiksa.
    ownerCookie = await login(ownerId, OWNER_PIN)

    const res = await api(
      'PATCH',
      '/api/settings',
      { ownerPin: OWNER_PIN, values: { qrisEnabled: 'true' } },
      ownerCookie,
    )
    expect(res.status).toBe(200)

    const row = await prisma.setting.findUnique({ where: { key: 'qrisEnabled' } })
    expect(row?.value).toBe('true')
  }, 60_000)

  it('4. kasir tidak boleh mengubah pengaturan, walau PIN pemiliknya benar', async () => {
    const res = await api(
      'PATCH',
      '/api/settings',
      { ownerPin: OWNER_PIN, values: { qrisEnabled: 'false' } },
      cashierCookie,
    )
    // Role dicek server sebelum apa pun. Menyembunyikan menu bukan otorisasi.
    expect(res.status).toBe(403)

    const row = await prisma.setting.findUnique({ where: { key: 'qrisEnabled' } })
    expect(row?.value).toBe('true')
  }, 60_000)

  it('5. route unggah gambar QR sudah tidak ada', async () => {
    // Permukaannya benar-benar hilang, bukan cuma tombolnya yang disembunyikan.
    // Selama route-nya masih hidup, ia tetap bisa dipanggil siapa pun di WiFi
    // toko dan tetap menulis berkas ke disk untuk fitur yang sudah tidak ada.
    const form = new FormData()
    form.set('ownerPin', OWNER_PIN)
    form.set('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 'qr.png')

    const res = await fetch(`${baseUrl}/api/settings/qris-image`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
      body: form,
    })
    expect(res.status).toBe(404)
  }, 60_000)

  it('6. perubahan qrisEnabled tercatat di audit log', async () => {
    const audits = await prisma.auditLog.findMany({ where: { action: 'SETTING_CHANGE' } })
    expect(audits.length).toBeGreaterThan(0)
    expect(audits.map((a) => a.summary).join(' ')).toMatch(/qrisEnabled/)
  }, 60_000)

  it('7. checkout QRIS SELESAI dalam satu langkah, stok langsung berkurang', async () => {
    // Inti seluruh perubahan. Dulu di sini transaksinya berhenti di PENDING dan
    // stok belum bergerak; kasir harus menekan tombol kedua.
    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: QTY, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
    })

    expect(res.status).toBe(201)
    expect(res.data.status).toBe('COMPLETED')
    transactionId = String(res.data.transactionId)
    paymentId = String(res.data.paymentId)

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(trx.status).toBe('COMPLETED')
    expect(trx.completedAt).not.toBeNull()

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(payment.status).toBe('PAID')
    expect(payment.method).toBe('QRIS_STATIC')
    expect(payment.providerName).toBe('qris-static')
    expect(payment.paidAt).not.toBeNull()
    // Dilunaskan oleh ORANG yang login, bukan oleh sistem.
    expect(payment.confirmedByUserId).toBe(cashierId)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(STOK_AWAL - QTY)

    const movements = await prisma.stockMovement.findMany({ where: { refId: transactionId } })
    expect(movements).toHaveLength(1)
    expect(movements[0]?.reason).toBe('SALE')
  }, 120_000)

  it('8. jalur QRIS tidak meninggalkan satu pun transaksi PENDING', async () => {
    // Invarian baru, dan inilah alasan alur dua langkah dihapus: transaksi
    // terlantar dulu lahir dari kasir yang lupa menekan tombol kedua, lalu
    // dibersihkan diam-diam saat tutup shift.
    expect(await prisma.transaction.count({ where: { status: 'PENDING' } })).toBe(0)
    expect(await prisma.payment.count({ where: { status: 'PENDING' } })).toBe(0)
  }, 60_000)

  it('9. konfirmasi ulang atas pembayaran yang sudah lunas ditolak 409', async () => {
    // State machine TETAP menjaga, dan ini yang membedakan "satu langkah" dari
    // "tanpa gerbang": PAID adalah state terminal, dan tidak ada transisi keluar
    // kecuali lewat void.
    const res = await api('POST', `/api/payments/${paymentId}/confirm`, {})
    expect(res.status).toBe(409)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(STOK_AWAL - QTY)
  }, 60_000)

  it('10. pembatalan atas pembayaran yang sudah lunas ditolak 409', async () => {
    const res = await api('POST', `/api/payments/${paymentId}/cancel`, {
      reason: 'Coba batalkan yang sudah lunas',
    })
    expect(res.status).toBe(409)
  }, 60_000)

  it('11. dua checkout QRIS serentak dengan kunci sama: tepat satu transaksi', async () => {
    const stokSebelum = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok
    const KUNCI = '55555555-5555-4555-8555-999999999999'
    const body = JSON.stringify({
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
      idempotencyKey: KUNCI,
    })

    const kirim = () =>
      fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cashierCookie },
        body,
      })

    const [a, b] = await Promise.all([kirim(), kirim()])
    expect([a.status, b.status].every((s) => s === 200 || s === 201)).toBe(true)

    // Satu langkah TIDAK berarti satu penjaga lebih sedikit: kunci sekali-pakai
    // tetap berlaku untuk QRIS persis seperti untuk tunai.
    expect(await prisma.transaction.count({ where: { idempotencyKey: KUNCI } })).toBe(1)
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(stokSebelum - 1)
  }, 120_000)

  it('12. baris PENDING dari provider dinamis masih bisa dilunaskan lewat /confirm', async () => {
    // Jalur PENDING → PAID TIDAK ikut dihapus. Ia tinggal untuk provider dinamis
    // (Midtrans/Xendit) yang akan memanggilnya lewat webhook, dan baris seperti
    // ini juga bisa tersisa dari data lama.
    //
    // Karena layar kasir tidak lagi membuatnya, barisnya dibuat langsung di
    // database — itu justru yang dilakukan webhook nanti.
    const trx = await prisma.transaction.create({
      data: {
        trxNumber: 'TRX-PENDING-001',
        businessDate: hariUsaha(),
        shiftId,
        cashierId,
        status: 'PENDING',
        grossSubtotal: HARGA_JUAL,
        itemDiscountTotal: 0,
        transactionDiscount: 0,
        netTotal: HARGA_JUAL,
        cogsTotal: HARGA_BELI,
        items: {
          create: [
            {
              productId,
              productName: 'Gula Pasir 1kg',
              sku: 'QR-001',
              unitPrice: HARGA_JUAL,
              unitCost: HARGA_BELI,
              qty: 1,
              lineGross: HARGA_JUAL,
              itemDiscount: 0,
              allocatedTxDiscount: 0,
              lineNet: HARGA_JUAL,
              lineFinal: HARGA_JUAL,
            },
          ],
        },
        payments: {
          create: [
            {
              method: 'QRIS_STATIC',
              status: 'PENDING',
              amount: HARGA_JUAL,
              providerName: 'qris-static',
            },
          ],
        },
      },
      include: { payments: true },
    })

    const pendingPayment = trx.payments[0]
    expect(pendingPayment).toBeDefined()

    const stokSebelum = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok

    const res = await api('POST', `/api/payments/${pendingPayment?.id}/confirm`, {})
    expect(res.status).toBe(200)

    const sesudah = await prisma.transaction.findUniqueOrThrow({ where: { id: trx.id } })
    expect(sesudah.status).toBe('COMPLETED')
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(stokSebelum - 1)
  }, 120_000)

  it('13. konfirmasi tanpa session ditolak 401 — PAID butuh orang yang dikenal', async () => {
    const res = await fetch(`${baseUrl}/api/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  }, 60_000)

  it('14. baris PENDING terlantar tetap dibatalkan otomatis saat tutup shift', async () => {
    // Mekanismenya dipertahankan walaupun layar kasir tidak lagi membuat baris
    // PENDING: provider dinamis nanti akan membuatnya, dan pelanggan yang
    // meninggalkan pembayaran di tengah jalan adalah kejadian yang sama.
    const terlantar = await prisma.transaction.create({
      data: {
        trxNumber: 'TRX-PENDING-002',
        businessDate: hariUsaha(),
        shiftId,
        cashierId,
        status: 'PENDING',
        grossSubtotal: HARGA_JUAL,
        itemDiscountTotal: 0,
        transactionDiscount: 0,
        netTotal: HARGA_JUAL,
        cogsTotal: HARGA_BELI,
        payments: {
          create: [
            {
              method: 'QRIS_STATIC',
              status: 'PENDING',
              amount: HARGA_JUAL,
              providerName: 'qris-static',
            },
          ],
        },
      },
    })

    const closed = await api('POST', `/api/shifts/${shiftId}/close`, { countedCash: KAS_AWAL })
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
    expect(result.summary.nonCashSales).toBeGreaterThan(0)

    const sesudah = await prisma.transaction.findUniqueOrThrow({ where: { id: terlantar.id } })
    expect(sesudah.status).toBe('CANCELLED')

    const audits = await prisma.auditLog.findMany({
      where: { action: 'PENDING_CANCELLED_ON_SHIFT_CLOSE' },
    })
    expect(audits).toHaveLength(1)

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(shift.status).toBe('CLOSED')
    expect(shift.openKey).toBeNull()
  }, 120_000)

  it('15. setelah shift ditutup, konfirmasi transaksi yang sudah dibatalkan tetap ditolak', async () => {
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
