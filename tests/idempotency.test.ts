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
        // Folder backup sendiri. WAJIB di setiap test yang menjalankan server:
        // tanpa ini, backup startup dan backup tutup shift menulis snapshot
        // DATABASE UJI ke folder backups/ toko, lalu memangkas backup asli untuk
        // memberi tempat. Berkasnya tidak bisa dibedakan dari backup sungguhan,
        // dan prosedur restore di README ("pilih yang paling baru") akan
        // mengembalikan database kosong berisi "Kasir E2E".
        BACKUP_DIR: path.join(tmpDir, 'backups'),
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

  it('4. Case A - TANPA kunci: DITOLAK 400, tanpa efek samping apa pun', async () => {
    // Berkas ini dulu memuat test berjudul "TANPA kunci, dua request identik
    // membuat dua transaksi" - dan test itu LULUS, karena kuncinya opsional.
    // Audit menyebutnya lubang: perlindungan bergantung pada kedisiplinan client.
    // Test yang sama kini dibalik menjadi bukti bahwa lubang itu tertutup.
    const trxSebelum = await prisma.transaction.count()
    const stokSebelum = await stok()

    const tanpaKunci = {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH' as const,
      amountTendered: 20_000,
    }

    const res = await api('POST', '/api/transactions', tanpaKunci)

    expect(res.status).toBe(400)
    // Bukan cuma status HTTP - database yang menentukan.
    expect(await prisma.transaction.count()).toBe(trxSebelum)
    expect(await stok()).toBe(stokSebelum)
  }, 120_000)

  it('4b. Case D - DUA request identik tanpa kunci: keduanya ditolak, nol transaksi', async () => {
    const trxSebelum = await prisma.transaction.count()
    const stokSebelum = await stok()
    const movementSebelum = await prisma.stockMovement.count()

    const tanpaKunci = {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH' as const,
      amountTendered: 20_000,
    }

    const a = await api('POST', '/api/transactions', tanpaKunci)
    const b = await api('POST', '/api/transactions', tanpaKunci)

    expect(a.status).toBe(400)
    expect(b.status).toBe(400)
    expect(await prisma.transaction.count()).toBe(trxSebelum)
    expect(await stok()).toBe(stokSebelum)
    expect(await prisma.stockMovement.count()).toBe(movementSebelum)
  }, 120_000)

  it('4c. Case E - kunci BERBEDA dengan payload sama: dua penjualan sah', async () => {
    // Penjagaan tidak boleh berubah menjadi deduplikasi tak sengaja. Dua
    // pelanggan membeli barang yang sama dengan jumlah yang sama adalah dua
    // penjualan, dan sistem harus mengizinkannya.
    const trxSebelum = await prisma.transaction.count()
    const stokSebelum = await stok()

    const isi = {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH' as const,
      amountTendered: 20_000,
    }

    const a = await api('POST', '/api/transactions', { ...isi, idempotencyKey: key('e1e1e1e1') })
    const b = await api('POST', '/api/transactions', { ...isi, idempotencyKey: key('e2e2e2e2') })

    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(a.data.trxNumber).not.toBe(b.data.trxNumber)
    expect(await prisma.transaction.count()).toBe(trxSebelum + 2)
    expect(await stok()).toBe(stokSebelum - 2)
  }, 120_000)

  it('4d. kunci berbentuk salah ditolak 400 tanpa menyentuh apa pun', async () => {
    const trxSebelum = await prisma.transaction.count()
    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 20_000,
      idempotencyKey: 'bukan-uuid',
    })
    expect(res.status).toBe(400)
    expect(await prisma.transaction.count()).toBe(trxSebelum)
  }, 120_000)

  it('4e. kunci divalidasi SEBELUM aturan bisnis lain (tanpa shift terbuka)', async () => {
    // Urutan penolakan menentukan tindakan kasir. Request tanpa kunci harus
    // dijawab 400 "kunci wajib", bukan 409 "belum ada shift" - dua pesan itu
    // menuntun ke dua tindakan yang sangat berbeda.
    const shift = await prisma.shift.findFirstOrThrow({ where: { status: 'OPEN' } })

    await prisma.shift.update({
      where: { id: shift.id },
      data: { status: 'CLOSED', openKey: null, closedAt: new Date() },
    })

    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 20_000,
    })
    expect(res.status).toBe(400)

    await prisma.shift.update({
      where: { id: shift.id },
      data: { status: 'OPEN', openKey: shift.cashierId, closedAt: null },
    })
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
      idempotencyKey: key('aaaa9999'),
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

  it('11. Case A/D refund - TANPA kunci: ditolak, tidak ada uang keluar', async () => {
    // Dibalik dari test lama yang membuktikan refund sebagian bisa terjadi dua
    // kali tanpa kunci.
    const item = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    const sebelum = item.refundedQty
    const refundSebelum = await prisma.refund.count({ where: { transactionId } })

    const tanpaKunci = {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId: itemId, qty: 1 }],
      method: 'CASH',
      reason: 'Barang rusak',
    }

    const a = await api('POST', `/api/transactions/${transactionId}/refunds`, tanpaKunci)
    const b = await api('POST', `/api/transactions/${transactionId}/refunds`, tanpaKunci)

    expect(a.status).toBe(400)
    expect(b.status).toBe(400)

    const sesudah = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    expect(sesudah.refundedQty).toBe(sebelum)
    expect(await prisma.refund.count({ where: { transactionId } })).toBe(refundSebelum)
  }, 120_000)

  it('11b. Case E refund - kunci berbeda memang menghasilkan refund kedua', async () => {
    // Refund sebagian dua kali adalah operasi SAH selama sisa qty cukup.
    // Idempotency tidak boleh melarangnya.
    const item = await prisma.transactionItem.findUniqueOrThrow({ where: { id: itemId } })
    const sebelum = item.refundedQty
    expect(item.qty - sebelum).toBeGreaterThan(0)

    const res = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId: itemId, qty: 1 }],
      method: 'CASH',
      reason: 'Barang rusak',
      idempotencyKey: key('bbbb1111'),
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

/**
 * Matriks A–E untuk tiga endpoint yang ditutup belakangan.
 *
 * Ketiganya sebelumnya tidak punya kunci sama sekali, dan penutupannya menuntut
 * migrasi schema karena `Expense` dan `StockMovement` tidak punya satu pun kolom
 * unique yang bisa menampung kunci. Yang diuji di bawah adalah matriks yang sama
 * persis seperti checkout dan refund, bukan versi yang lebih longgar:
 *
 *   A  tanpa kunci                  → 400, nol efek samping
 *   B  kunci sama, isi sama         → 201 lalu 200, efeknya sekali
 *   C  kunci sama, isi berbeda      → 409, nol efek tambahan
 *   D  dua request serentak         → tepat satu efek
 *   E  kunci berbeda, isi sama      → dua operasi, memang dua peristiwa
 */

/** Kirim dua request identik benar-benar bersamaan, apa adanya lewat HTTP. */
async function serentak(
  pathname: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }[]> {
  const isi = JSON.stringify(body)
  const kirim = () =>
    fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: isi,
    })

  const hasil = await Promise.all([kirim(), kirim()])
  return Promise.all(
    hasil.map(async (r) => ({
      status: r.status,
      data: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    })),
  )
}

describe('kunci sekali-pakai pada pengeluaran kas', () => {
  const E1 = key('e1aae1aae1aae1aae1aae1aae1aae1aa')
  const E_SERENTAK = key('e5aae5aae5aae5aae5aae5aae5aae5aa')
  const E_LAIN = key('e9aae9aae9aae9aae9aae9aae9aae9aa')

  const isi = {
    kategori: 'Operasional',
    amount: 15_000,
    note: 'Beli kantong plastik',
    paidFrom: 'CASH_DRAWER' as const,
  }

  let expenseIdPertama = ''
  let kasSetelahPertama = 0

  async function jumlahExpense(): Promise<number> {
    return prisma.expense.count()
  }

  async function cashExpenses(): Promise<number> {
    const current = await api('GET', '/api/shifts/current')
    const summary = current.data.summary as { cashExpenses: number }
    return summary.cashExpenses
  }

  it('13. Case A - tanpa kunci: 400, tidak ada uang keluar', async () => {
    await loginAs(cashierId, CASHIER_PIN)

    const sebelum = await jumlahExpense()
    const res = await api('POST', '/api/expenses', isi)

    expect(res.status).toBe(400)
    expect(await jumlahExpense()).toBe(sebelum)
  }, 120_000)

  it('14. Case B pertama - dengan kunci: 201, tercatat sekali', async () => {
    const sebelum = await jumlahExpense()
    const res = await api('POST', '/api/expenses', { ...isi, idempotencyKey: E1 })

    expect(res.status).toBe(201)
    expect(res.data.replayed).toBe(false)
    const expense = res.data.expense as { id: string; amount: number }
    expenseIdPertama = expense.id
    expect(expense.amount).toBe(15_000)

    expect(await jumlahExpense()).toBe(sebelum + 1)
    kasSetelahPertama = await cashExpenses()
  }, 120_000)

  it('15. Case B kedua - kunci sama: 200, expected cash TIDAK turun dua kali', async () => {
    // Inti masalahnya bukan barisnya yang dobel, melainkan akibatnya: pengeluaran
    // yang tercatat dua kali menurunkan expected cash dua kali, dan yang tampak
    // kehilangan uang adalah kasirnya.
    const sebelum = await jumlahExpense()
    const res = await api('POST', '/api/expenses', { ...isi, idempotencyKey: E1 })

    expect(res.status).toBe(200)
    expect(res.data.replayed).toBe(true)
    expect((res.data.expense as { id: string }).id).toBe(expenseIdPertama)

    expect(await jumlahExpense()).toBe(sebelum)
    expect(await cashExpenses()).toBe(kasSetelahPertama)
  }, 120_000)

  it('16. Case C - kunci sama, nominal berbeda: 409', async () => {
    const sebelum = await jumlahExpense()
    const res = await api('POST', '/api/expenses', {
      ...isi,
      amount: 90_000,
      idempotencyKey: E1,
    })

    expect(res.status).toBe(409)
    expect(await jumlahExpense()).toBe(sebelum)
    expect(await cashExpenses()).toBe(kasSetelahPertama)
  }, 120_000)

  it('17. Case D - dua request serentak dengan kunci sama: tepat satu baris', async () => {
    const sebelum = await jumlahExpense()

    const [a, b] = await serentak('/api/expenses', {
      ...isi,
      amount: 7_500,
      idempotencyKey: E_SERENTAK,
    })

    expect(a && b).toBeTruthy()
    expect([a?.status, b?.status].every((s) => s === 200 || s === 201)).toBe(true)
    expect((a?.data.expense as { id: string }).id).toBe((b?.data.expense as { id: string }).id)

    expect(await prisma.expense.count({ where: { idempotencyKey: E_SERENTAK } })).toBe(1)
    expect(await jumlahExpense()).toBe(sebelum + 1)
  }, 120_000)

  it('18. Case E - kunci berbeda, isi sama: dua pengeluaran yang memang sah', async () => {
    // Dua kali beli kantong plastik dengan nominal yang sama dalam satu shift
    // adalah dua pengeluaran nyata. Penjagaan tidak boleh berubah menjadi
    // deduplikasi tak sengaja.
    const sebelum = await jumlahExpense()
    const kasSebelum = await cashExpenses()

    const res = await api('POST', '/api/expenses', { ...isi, idempotencyKey: E_LAIN })

    expect(res.status).toBe(201)
    expect(res.data.replayed).toBe(false)
    expect((res.data.expense as { id: string }).id).not.toBe(expenseIdPertama)

    expect(await jumlahExpense()).toBe(sebelum + 1)
    expect(await cashExpenses()).toBe(kasSebelum + 15_000)
  }, 120_000)

  it('19. kunci yang bentuknya bukan UUID: 400', async () => {
    const sebelum = await jumlahExpense()
    const res = await api('POST', '/api/expenses', { ...isi, idempotencyKey: 'bukan-uuid' })

    expect(res.status).toBe(400)
    expect(await jumlahExpense()).toBe(sebelum)
  }, 120_000)

  it('20. kunci milik kasir lain: 409, bukan dijawab dengan datanya', async () => {
    // Pemilik punya shift terbuka sendiri (dibuka di test 6), jadi yang diuji di
    // sini benar-benar pemilik kuncinya — bukan kebetulan tidak ada shift.
    await loginAs(ownerId, OWNER_PIN)

    const sebelum = await jumlahExpense()
    const res = await api('POST', '/api/expenses', { ...isi, idempotencyKey: E1 })

    expect(res.status).toBe(409)
    expect(await jumlahExpense()).toBe(sebelum)
  }, 120_000)
})

describe('kunci sekali-pakai pada barang masuk', () => {
  const M1 = key('11bb11bb11bb11bb11bb11bb11bb11bb')
  const M_SERENTAK = key('55bb55bb55bb55bb55bb55bb55bb55bb')
  const M_LAIN = key('99bb99bb99bb99bb99bb99bb99bb99bb')

  const isi = { qty: 24, hargaBeli: HARGA_BELI + 500, note: 'Kiriman pemasok' }

  let stockAfterPertama = 0

  async function jumlahPurchase(): Promise<number> {
    return prisma.stockMovement.count({ where: { productId, reason: 'PURCHASE' } })
  }

  it('21. Case A - tanpa kunci: 400, stok tidak naik', async () => {
    await loginAs(ownerId, OWNER_PIN)

    const stokSebelum = await stok()
    const gerakSebelum = await jumlahPurchase()

    const res = await api('POST', `/api/products/${productId}/stock-in`, isi)

    expect(res.status).toBe(400)
    expect(await stok()).toBe(stokSebelum)
    expect(await jumlahPurchase()).toBe(gerakSebelum)
  }, 120_000)

  it('22. Case B pertama - dengan kunci: 201, stok naik sekali', async () => {
    const stokSebelum = await stok()
    const gerakSebelum = await jumlahPurchase()

    const res = await api('POST', `/api/products/${productId}/stock-in`, {
      ...isi,
      idempotencyKey: M1,
    })

    expect(res.status).toBe(201)
    expect(res.data.replayed).toBe(false)
    expect(res.data.hargaBeliChanged).toBe(true)
    stockAfterPertama = Number(res.data.stockAfter)

    expect(await stok()).toBe(stokSebelum + 24)
    expect(await jumlahPurchase()).toBe(gerakSebelum + 1)
  }, 120_000)

  it('23. Case B kedua - kunci sama: 200, stok TIDAK naik dua kali', async () => {
    const stokSebelum = await stok()
    const gerakSebelum = await jumlahPurchase()

    const res = await api('POST', `/api/products/${productId}/stock-in`, {
      ...isi,
      idempotencyKey: M1,
    })

    expect(res.status).toBe(200)
    expect(res.data.replayed).toBe(true)
    // Angka yang dijawab adalah angka SAAT barang itu masuk, dibaca dari baris
    // pergerakannya — bukan stok sekarang, yang sudah bergerak sejak itu.
    expect(res.data.stockAfter).toBe(stockAfterPertama)

    expect(await stok()).toBe(stokSebelum)
    expect(await jumlahPurchase()).toBe(gerakSebelum)
  }, 120_000)

  it('24. Case C - kunci sama, jumlah berbeda: 409', async () => {
    const stokSebelum = await stok()
    const res = await api('POST', `/api/products/${productId}/stock-in`, {
      ...isi,
      qty: 100,
      idempotencyKey: M1,
    })

    expect(res.status).toBe(409)
    expect(await stok()).toBe(stokSebelum)
  }, 120_000)

  it('25. Case D - dua request serentak dengan kunci sama: satu pergerakan', async () => {
    const stokSebelum = await stok()

    const [a, b] = await serentak(`/api/products/${productId}/stock-in`, {
      qty: 6,
      note: 'Serentak',
      idempotencyKey: M_SERENTAK,
    })

    expect([a?.status, b?.status].every((s) => s === 200 || s === 201)).toBe(true)
    expect(
      await prisma.stockMovement.count({ where: { idempotencyKey: M_SERENTAK } }),
    ).toBe(1)
    expect(await stok()).toBe(stokSebelum + 6)
  }, 120_000)

  it('26. Case E - kunci berbeda, isi sama: barang masuk kedua yang sah', async () => {
    const stokSebelum = await stok()

    const res = await api('POST', `/api/products/${productId}/stock-in`, {
      ...isi,
      idempotencyKey: M_LAIN,
    })

    expect(res.status).toBe(201)
    expect(res.data.replayed).toBe(false)
    expect(await stok()).toBe(stokSebelum + 24)
  }, 120_000)

  it('27. kunci yang bentuknya bukan UUID: 400', async () => {
    const stokSebelum = await stok()
    const res = await api('POST', `/api/products/${productId}/stock-in`, {
      ...isi,
      idempotencyKey: 'bukan-uuid',
    })

    expect(res.status).toBe(400)
    expect(await stok()).toBe(stokSebelum)
  }, 120_000)

  it('28. kunci milik pengguna lain: 409', async () => {
    // Endpoint ini khusus OWNER, jadi "pengguna lain" berarti pemilik kedua —
    // toko yang dipegang dua orang. Kalau kunci orang lain dijawab dengan data,
    // pemilik kedua melihat pergerakan stok yang bukan ia catat.
    const ownerDua = await prisma.user.create({
      data: {
        name: 'Pemilik Kedua Idem',
        role: 'OWNER',
        pinHash: await bcrypt.hash('313233', 10),
      },
    })
    await loginAs(ownerDua.id, '313233')

    const stokSebelum = await stok()
    const res = await api('POST', `/api/products/${productId}/stock-in`, {
      ...isi,
      idempotencyKey: M1,
    })

    expect(res.status).toBe(409)
    expect(await stok()).toBe(stokSebelum)
  }, 120_000)
})

describe('kunci sekali-pakai pada penyesuaian stok', () => {
  const S1 = key('11cc11cc11cc11cc11cc11cc11cc11cc')
  const S_SERENTAK = key('55cc55cc55cc55cc55cc55cc55cc55cc')
  const S_LAIN = key('99cc99cc99cc99cc99cc99cc99cc99cc')
  const S_OPNAME = key('77cc77cc77cc77cc77cc77cc77cc77cc')

  const isi = { qtyChange: -3, reason: 'ADJUSTMENT' as const, note: 'Rusak di rak' }

  async function jumlahManual(): Promise<number> {
    return prisma.stockMovement.count({ where: { productId, refType: 'MANUAL' } })
  }

  it('29. Case A - tanpa kunci: 400, stok tidak bergeser', async () => {
    await loginAs(ownerId, OWNER_PIN)

    const stokSebelum = await stok()
    const res = await api('POST', `/api/products/${productId}/stock-adjustment`, isi)

    expect(res.status).toBe(400)
    expect(await stok()).toBe(stokSebelum)
  }, 120_000)

  it('30. Case B pertama - dengan kunci: 201, koreksi berlaku sekali', async () => {
    const stokSebelum = await stok()
    const res = await api('POST', `/api/products/${productId}/stock-adjustment`, {
      ...isi,
      idempotencyKey: S1,
    })

    expect(res.status).toBe(201)
    expect(res.data.replayed).toBe(false)
    expect(await stok()).toBe(stokSebelum - 3)
  }, 120_000)

  it('31. Case B kedua - kunci sama: 200, koreksi TIDAK berlaku dua kali', async () => {
    const stokSebelum = await stok()
    const gerakSebelum = await jumlahManual()

    const res = await api('POST', `/api/products/${productId}/stock-adjustment`, {
      ...isi,
      idempotencyKey: S1,
    })

    expect(res.status).toBe(200)
    expect(res.data.replayed).toBe(true)
    expect(res.data.qtyChange).toBe(-3)
    expect(await stok()).toBe(stokSebelum)
    expect(await jumlahManual()).toBe(gerakSebelum)
  }, 120_000)

  it('32. Case C - kunci sama, alasan berbeda: 409', async () => {
    const stokSebelum = await stok()
    const res = await api('POST', `/api/products/${productId}/stock-adjustment`, {
      ...isi,
      reason: 'OPNAME',
      idempotencyKey: S1,
    })

    expect(res.status).toBe(409)
    expect(await stok()).toBe(stokSebelum)
  }, 120_000)

  it('33. Case D - dua request serentak dengan kunci sama: satu pergerakan', async () => {
    const stokSebelum = await stok()

    const [a, b] = await serentak(`/api/products/${productId}/stock-adjustment`, {
      qtyChange: -2,
      reason: 'ADJUSTMENT',
      note: 'Serentak',
      idempotencyKey: S_SERENTAK,
    })

    expect([a?.status, b?.status].every((s) => s === 200 || s === 201)).toBe(true)
    expect(
      await prisma.stockMovement.count({ where: { idempotencyKey: S_SERENTAK } }),
    ).toBe(1)
    expect(await stok()).toBe(stokSebelum - 2)
  }, 120_000)

  it('34. Case E - kunci berbeda, isi sama: penyesuaian kedua yang sah', async () => {
    const stokSebelum = await stok()

    const res = await api('POST', `/api/products/${productId}/stock-adjustment`, {
      ...isi,
      idempotencyKey: S_LAIN,
    })

    expect(res.status).toBe(201)
    expect(await stok()).toBe(stokSebelum - 3)
  }, 120_000)

  it('35. mode newQty: sidik jari memakai angka MENTAH, bukan hasil hitungannya', async () => {
    // Ini keputusan desain yang paling mudah salah. `newQty` dikonversi menjadi
    // selisih terhadap stok SAAT ITU. Kalau sidik jarinya memakai hasil konversi,
    // maka setelah stok bergerak karena hal lain, pengulangan request yang SAMA
    // PERSIS akan menghasilkan selisih berbeda → sidik jari berbeda → 409 "kunci
    // dipakai untuk isi berbeda", padahal kasir hanya mengulang request yang
    // response-nya hilang.
    const body = { newQty: 100, reason: 'OPNAME' as const, note: 'Hitung fisik' }

    const pertama = await api('POST', `/api/products/${productId}/stock-adjustment`, {
      ...body,
      idempotencyKey: S_OPNAME,
    })
    expect(pertama.status).toBe(201)
    expect(await stok()).toBe(100)

    // Stok digeser oleh operasi LAIN di antaranya — inilah yang membuat hasil
    // konversi berubah.
    const lain = await api('POST', `/api/products/${productId}/stock-in`, {
      qty: 7,
      idempotencyKey: key('aa11bb22cc33dd44ee55ff6677889900'),
    })
    expect(lain.status).toBe(201)
    expect(await stok()).toBe(107)

    const ulang = await api('POST', `/api/products/${productId}/stock-adjustment`, {
      ...body,
      idempotencyKey: S_OPNAME,
    })

    // 200, bukan 409: request-nya sama persis, jadi ia pengulangan.
    expect(ulang.status).toBe(200)
    expect(ulang.data.replayed).toBe(true)
    // Dan stoknya TIDAK dikembalikan ke 100. Pengulangan tidak menerapkan apa pun.
    expect(await stok()).toBe(107)
  }, 120_000)
})
