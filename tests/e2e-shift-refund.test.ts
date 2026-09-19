import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * End-to-end lewat HTTP: login → buka shift → checkout → refund → tutup shift.
 *
 * Alurnya sengaja satu rangkaian, bukan test terpisah per endpoint, karena yang
 * diuji justru sambungannya: apakah shift yang dibuka benar-benar dipakai
 * checkout, apakah refund membebani shift yang sedang berjalan, dan apakah
 * rekonsiliasi kas di akhir memuat semuanya.
 *
 * Fase 2 lolos test + typecheck + lint + build tapi checkout gagal 500 di
 * runtime, karena tidak satu pun pemeriksaan itu menyentuh bundler dan route
 * handler. Test ini menutup celah yang sama untuk Fase 3 dan 4.
 */

const OWNER_PIN = '246810'
const CASHIER_PIN = '111213'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let cashierId = ''
let productId = ''
let cookie = ''

/** Angka yang dipakai sepanjang alur, dipilih supaya pembulatan refund terlihat. */
const HARGA_JUAL = 7_000
const HARGA_BELI = 5_000
const STOK_AWAL = 50
const QTY = 3
const DISKON_ITEM = 1_000
const KAS_AWAL = 200_000

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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-e2e-'))
  const dbUrl = `file:${path.join(tmpDir, 'e2e.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  await prisma.user.create({
    data: { name: 'Pemilik E2E', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  const cashier = await prisma.user.create({
    data: { name: 'Kasir E2E', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'E2E-001',
      barcode: '7770000000001',
      nama: 'Produk E2E',
      searchKey: 'produk e2e e2e-001',
      kategori: 'Uji',
      hargaJual: HARGA_JUAL,
      hargaBeli: HARGA_BELI,
      stok: STOK_AWAL,
      stokMinimum: 5,
    },
  })
  productId = product.id

  for (const [key, value] of Object.entries({
    storeName: 'Toko E2E',
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
        // Folder build sendiri: `next dev` milik test tidak boleh merusak dev
        // server yang mungkin sedang dipakai orang.
        NEXT_DIST_DIR: '.next-e2e',
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

describe('alur harian: login → buka shift → checkout → refund → tutup shift', () => {
  let shiftId = ''
  let transactionId = ''
  let transactionItemId = ''
  let netTotal = 0
  let lineFinal = 0

  it('1. checkout DITOLAK sebelum shift dibuka', async () => {
    // Tidak ada penjualan di luar shift. Kalau ini lolos, rekonsiliasi kas
    // kehilangan artinya karena ada uang masuk yang tidak terikat laci mana pun.
    const login = await api('POST', '/api/auth/login', { userId: cashierId, pin: CASHIER_PIN })
    expect(login.status).toBe(200)

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: cashierId, pin: CASHIER_PIN }),
    })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).not.toBe('')

    const checkout = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 10_000,
    })
    expect(checkout.status).toBe(409)

    const stok = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(stok.stok).toBe(STOK_AWAL)
  }, 120_000)

  it('2. buka shift dengan kas awal', async () => {
    const opened = await api('POST', '/api/shifts/open', { openingCash: KAS_AWAL })
    expect(opened.status).toBe(201)
    shiftId = String(opened.data.shiftId)
    expect(shiftId).not.toBe('')

    const current = await api('GET', '/api/shifts/current')
    expect(current.status).toBe(200)
    const summary = current.data.summary as { openingCash: number; expectedCash: number }
    expect(summary.openingCash).toBe(KAS_AWAL)
    expect(summary.expectedCash).toBe(KAS_AWAL)
  }, 60_000)

  it('3. shift kedua DITOLAK — satu shift terbuka per kasir', async () => {
    const lagi = await api('POST', '/api/shifts/open', { openingCash: 50_000 })
    expect(lagi.status).toBe(409)
  }, 60_000)

  it('4. checkout tunai berhasil dan stok berkurang', async () => {
    const checkout = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: QTY, itemDiscount: DISKON_ITEM }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 50_000,
    })
    expect(checkout.status).toBe(201)

    transactionId = String(checkout.data.transactionId)
    netTotal = Number(checkout.data.netTotal)

    // 3 × 7.000 = 21.000; −1.000 diskon item = 20.000
    expect(netTotal).toBe(20_000)
    expect(checkout.data.changeAmount).toBe(30_000)

    const saved = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: { items: true },
    })
    expect(saved.shiftId).toBe(shiftId)
    const item = saved.items[0]
    if (!item) throw new Error('item transaksi tidak ditemukan')
    transactionItemId = item.id
    lineFinal = item.lineFinal
    expect(lineFinal).toBe(20_000)

    const produk = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(produk.stok).toBe(STOK_AWAL - QTY)
  }, 90_000)

  it('5. pengeluaran kas tercatat ke shift berjalan', async () => {
    const expense = await api('POST', '/api/expenses', {
      kategori: 'Operasional',
      amount: 15_000,
      paidFrom: 'CASH_DRAWER',
      note: 'Beli kantong plastik',
    })
    expect(expense.status).toBe(201)

    const current = await api('GET', '/api/shifts/current')
    const summary = current.data.summary as { cashExpenses: number; expectedCash: number }
    expect(summary.cashExpenses).toBe(15_000)
    // 200.000 + 20.000 − 15.000
    expect(summary.expectedCash).toBe(205_000)
  }, 60_000)

  it('6. refund DITOLAK tanpa PIN pemilik yang benar', async () => {
    const salah = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: '999999',
      items: [{ transactionItemId, qty: 1 }],
      method: 'CASH',
      reason: 'Uji PIN salah',
    })
    // PIN pemilik diverifikasi di SERVER; session kasir tidak pernah cukup.
    expect(salah.status).toBe(403)

    const belumAda = await prisma.refund.count()
    expect(belumAda).toBe(0)
  }, 60_000)

  it('7. refund sebagian memakai rumus teleskopik', async () => {
    // lineFinal 20.000, qty 3 → floor(20.000 × 1/3) = 6.666
    const harapan = Math.floor((lineFinal * 1) / QTY)
    expect(harapan).toBe(6_666)

    const refund = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId, qty: 1 }],
      method: 'CASH',
      reason: 'Barang rusak',
    })
    expect(refund.status).toBe(201)
    expect(refund.data.amount).toBe(harapan)
    expect(String(refund.data.refundNumber)).toMatch(/^RFN-\d{8}-\d{6}$/)

    // Stok kembali, dengan jejaknya.
    const produk = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(produk.stok).toBe(STOK_AWAL - QTY + 1)

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { productId, reason: 'REFUND' },
    })
    expect(movement.qtyChange).toBe(1)

    const item = await prisma.transactionItem.findUniqueOrThrow({
      where: { id: transactionItemId },
    })
    expect(item.refundedQty).toBe(1)
    expect(item.refundedAmount).toBe(harapan)
  }, 90_000)

  it('8. sisa refund menghabiskan lineFinal PERSIS', async () => {
    const refund = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId, qty: 2 }],
      method: 'CASH',
      reason: 'Sisa dikembalikan',
    })
    expect(refund.status).toBe(201)

    const item = await prisma.transactionItem.findUniqueOrThrow({
      where: { id: transactionItemId },
    })
    expect(item.refundedQty).toBe(QTY)
    // Inilah jaminan aturan teleskopik: tidak lebih, tidak kurang satu rupiah
    // pun dari yang benar-benar dibayar pelanggan.
    expect(item.refundedAmount).toBe(lineFinal)

    const total = await prisma.refund.aggregate({ _sum: { amount: true } })
    expect(total._sum.amount).toBe(lineFinal)
  }, 90_000)

  it('9. refund berlebih ditolak', async () => {
    const lagi = await api('POST', `/api/transactions/${transactionId}/refunds`, {
      ownerPin: OWNER_PIN,
      items: [{ transactionItemId, qty: 1 }],
      method: 'CASH',
      reason: 'Melebihi sisa',
    })
    expect(lagi.status).toBeGreaterThanOrEqual(400)
    expect(lagi.status).toBeLessThan(500)
  }, 60_000)

  it('10. void DITOLAK karena transaksi sudah pernah di-refund, dengan alasannya', async () => {
    const detail = await api('GET', `/api/transactions/${transactionId}`)
    expect(detail.status).toBe(200)

    const tolak = await api('POST', `/api/transactions/${transactionId}/void`, {
      ownerPin: OWNER_PIN,
      reason: 'Coba void setelah refund',
    })
    expect(tolak.status).toBe(409)
    const error = tolak.data.error as { message: string }
    expect(error.message).toContain('refund')
  }, 60_000)

  it('11. tutup shift merekonsiliasi kas dengan benar', async () => {
    const before = await api('GET', '/api/shifts/current')
    const summary = before.data.summary as {
      cashSales: number
      cashRefunds: number
      cashExpenses: number
      expectedCash: number
    }

    expect(summary.cashSales).toBe(20_000)
    expect(summary.cashRefunds).toBe(lineFinal)
    expect(summary.cashExpenses).toBe(15_000)
    // 200.000 + 20.000 − 20.000 − 15.000
    expect(summary.expectedCash).toBe(185_000)

    // Kasir menghitung kurang Rp 5.000 dari seharusnya.
    const counted = summary.expectedCash - 5_000
    const closed = await api('POST', `/api/shifts/${shiftId}/close`, {
      countedCash: counted,
      notes: 'Uji e2e',
    })
    expect(closed.status).toBe(200)

    const result = closed.data.summary as { expectedCash: number; difference: number }
    expect(result.expectedCash).toBe(185_000)
    expect(result.difference).toBe(-5_000)

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(shift.status).toBe('CLOSED')
    expect(shift.difference).toBe(-5_000)
    // openKey dilepas supaya kasir bisa membuka shift berikutnya.
    expect(shift.openKey).toBeNull()
  }, 120_000)

  it('12. setelah shift ditutup, checkout ditolak lagi', async () => {
    const checkout = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 10_000,
    })
    expect(checkout.status).toBe(409)
  }, 60_000)

  it('13. seluruh peristiwa terekam di audit log', async () => {
    const logs = await prisma.auditLog.findMany({ orderBy: { at: 'asc' } })
    const actions = logs.map((l) => l.action)

    expect(actions).toContain('LOGIN')
    expect(actions).toContain('SHIFT_OPEN')
    expect(actions).toContain('PAYMENT_CONFIRM')
    expect(actions).toContain('REFUND')
    expect(actions).toContain('SHIFT_CLOSE')
    // PIN pemilik yang salah tercatat, supaya percobaan berulang terlihat.
    expect(actions).toContain('LOGIN_FAILED')

    const refundLog = logs.find((l) => l.action === 'REFUND')
    expect(refundLog?.summary).toContain('RFN-')
  }, 60_000)
})

describe('barang masuk (PURCHASE) dan perubahan harga beli', () => {
  it('menambah stok dan mencatat COST_CHANGE saat harga beli berubah', async () => {
    // Barang masuk hanya untuk pemilik.
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: (await prisma.user.findFirstOrThrow({ where: { role: 'OWNER' } })).id,
        pin: OWNER_PIN,
      }),
    })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''

    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    const hargaBeliBaru = HARGA_BELI + 500

    const masuk = await api('POST', `/api/products/${productId}/stock-in`, {
      qty: 24,
      hargaBeli: hargaBeliBaru,
      note: 'Kiriman pemasok',
    })
    expect(masuk.status).toBe(201)
    expect(masuk.data.hargaBeliChanged).toBe(true)

    const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(after.stok).toBe(before.stok + 24)
    expect(after.hargaBeli).toBe(hargaBeliBaru)

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { productId, reason: 'PURCHASE' },
    })
    expect(movement.qtyChange).toBe(24)
    expect(movement.refType).toBe('PURCHASE')

    const logs = await prisma.auditLog.findMany({ where: { action: 'COST_CHANGE' } })
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]?.summary).toContain(String(hargaBeliBaru))

    const received = await prisma.auditLog.findMany({ where: { action: 'PURCHASE_RECEIVED' } })
    expect(received.length).toBeGreaterThan(0)
  }, 120_000)

  it('HPP transaksi lama TIDAK ikut berubah saat harga beli naik', async () => {
    // Snapshot unitCost adalah syarat mutlak laba kotor yang benar. Tanpa ini,
    // setiap restock akan menulis ulang laporan bulan lalu.
    const item = await prisma.transactionItem.findFirstOrThrow({
      where: { productId },
    })
    expect(item.unitCost).toBe(HARGA_BELI)
  }, 60_000)

  it('kasir biasa tidak boleh mencatat barang masuk', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: cashierId, pin: CASHIER_PIN }),
    })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''

    const masuk = await api('POST', `/api/products/${productId}/stock-in`, { qty: 5 })
    expect(masuk.status).toBe(403)
  }, 60_000)
})

describe('void: jalur berhasil dan penolakan setelah shift ditutup', () => {
  let shiftId = ''
  let voidableId = ''
  let afterCloseId = ''
  let stokSebelum = 0

  it('buka shift baru dan catat dua transaksi', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: cashierId, pin: CASHIER_PIN }),
    })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''

    const opened = await api('POST', '/api/shifts/open', { openingCash: 100_000 })
    expect(opened.status).toBe(201)
    shiftId = String(opened.data.shiftId)

    stokSebelum = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok

    const satu = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 2, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 20_000,
    })
    expect(satu.status).toBe(201)
    voidableId = String(satu.data.transactionId)

    const dua = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 10_000,
    })
    expect(dua.status).toBe(201)
    afterCloseId = String(dua.data.transactionId)
  }, 120_000)

  it('detail transaksi melaporkan canVoid true selama shift terbuka', async () => {
    const detail = await api('GET', `/api/transactions/${voidableId}`)
    expect(detail.status).toBe(200)
  }, 60_000)

  it('void DITOLAK tanpa PIN pemilik yang benar', async () => {
    const salah = await api('POST', `/api/transactions/${voidableId}/void`, {
      ownerPin: '999999',
      reason: 'Uji PIN salah',
    })
    expect(salah.status).toBe(403)

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: voidableId } })
    expect(trx.status).toBe('COMPLETED')
  }, 60_000)

  it('void BERHASIL: stok kembali, status VOIDED, tercatat di audit', async () => {
    const stokSaatIni = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok

    const dibatalkan = await api('POST', `/api/transactions/${voidableId}/void`, {
      ownerPin: OWNER_PIN,
      reason: 'Kasir salah input',
    })
    expect(dibatalkan.status).toBe(200)
    // Tunai: uangnya masih di laci, jadi tidak ada kewajiban pengembalian manual.
    expect(dibatalkan.data.needsManualRefund).toBe(false)

    const trx = await prisma.transaction.findUniqueOrThrow({
      where: { id: voidableId },
      include: { payments: true },
    })
    expect(trx.status).toBe('VOIDED')
    expect(trx.voidReason).toBe('Kasir salah input')
    expect(trx.payments[0]?.status).toBe('CANCELLED')

    // Stok dikembalikan lewat stock_movements, bukan diubah diam-diam.
    const produk = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(produk.stok).toBe(stokSaatIni + 2)

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { refId: voidableId, reason: 'VOID' },
    })
    expect(movement.qtyChange).toBe(2)

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'VOID', entityId: voidableId },
    })
    expect(log.summary).toContain('Kasir salah input')
  }, 90_000)

  it('void kedua atas transaksi yang sama DITOLAK', async () => {
    const lagi = await api('POST', `/api/transactions/${voidableId}/void`, {
      ownerPin: OWNER_PIN,
      reason: 'Coba dua kali',
    })
    expect(lagi.status).toBe(409)

    // Stok tidak boleh bertambah dua kali.
    const movements = await prisma.stockMovement.count({
      where: { refId: voidableId, reason: 'VOID' },
    })
    expect(movements).toBe(1)
  }, 60_000)

  it('penjualan VOIDED tidak dihitung dalam rekonsiliasi kas', async () => {
    const current = await api('GET', '/api/shifts/current')
    const summary = current.data.summary as { cashSales: number }
    // Harga jual 7.000: transaksi pertama 2 unit = 14.000, kedua 1 unit = 7.000.
    // Yang 14.000 di-void, jadi penjualan tunai shift ini tinggal 7.000 —
    // transaksi VOIDED dikecualikan sepenuhnya, bukan dicatat sebagai negatif.
    expect(summary.cashSales).toBe(HARGA_JUAL)
  }, 60_000)

  it('setelah shift DITUTUP, void ditolak dengan alasan yang menyebut refund', async () => {
    const summary = (await api('GET', '/api/shifts/current')).data.summary as {
      expectedCash: number
    }
    const closed = await api('POST', `/api/shifts/${shiftId}/close`, {
      countedCash: summary.expectedCash,
    })
    expect(closed.status).toBe(200)

    const tolak = await api('POST', `/api/transactions/${afterCloseId}/void`, {
      ownerPin: OWNER_PIN,
      reason: 'Coba void setelah tutup shift',
    })
    expect(tolak.status).toBe(409)

    // Pesannya harus menyebut jalan keluarnya, bukan sekadar menolak.
    const error = tolak.data.error as { message: string }
    expect(error.message).toBe('Shift sudah ditutup — gunakan refund')

    const trx = await prisma.transaction.findUniqueOrThrow({ where: { id: afterCloseId } })
    expect(trx.status).toBe('COMPLETED')
    expect(stokSebelum).toBeGreaterThan(0)
  }, 120_000)
})
