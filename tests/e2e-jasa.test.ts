import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Jasa pembayaran lewat HTTP.
 *
 * Ada di lapisan ini, bukan cukup di lapisan service, karena aturan proyek:
 * setiap endpoint yang menyentuh uang wajib punya test di lapisan HTTP. Untuk
 * jasa taruhannya lebih besar daripada biasa — satu transaksi menyentuh TIGA
 * tempat penyimpanan uang sekaligus (laci kas, saldo provider, dan angka omzet),
 * dan ketiganya bergerak ke arah yang berbeda.
 *
 * Pernyataan yang dijaga seluruh berkas ini:
 *
 *   TITIPAN TIDAK PERNAH MASUK OMZET.
 *
 * Token listrik Rp 100.000 dengan admin Rp 2.500 adalah omzet Rp 2.500, uang
 * masuk laci Rp 102.500, dan saldo provider turun Rp 100.000. Tiga angka
 * berbeda untuk satu transaksi, dan tidak satu pun boleh tertukar.
 */

const OWNER_PIN = '135791'
const CASHIER_PIN = '246802'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let cashierId = ''
let ownerId = ''
let productId = ''
let cookie = ''

const HARGA_JUAL = 3_500
const HARGA_BELI = 2_800
const STOK_AWAL = 40
const KAS_AWAL = 500_000
const SALDO_AWAL = 1_000_000

let urutanKunci = 0
function kunci(): string {
  urutanKunci += 1
  return `66666666-6666-4666-8666-${String(urutanKunci).padStart(12, '0')}`
}

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

/** Endpoint yang mewajibkan kunci sekali-pakai. */
function butuhKunci(pathname: string): boolean {
  return (
    pathname === '/api/transactions' ||
    pathname.endsWith('/topup') ||
    pathname.endsWith('/adjustment')
  )
}

async function api(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let isi = body
  if (butuhKunci(pathname) && typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>
    if (!('idempotencyKey' in obj)) isi = { ...obj, idempotencyKey: kunci() }
  }

  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(isi === undefined ? {} : { body: JSON.stringify(isi) }),
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

async function saldo(providerId: string): Promise<number> {
  const p = await prisma.serviceProvider.findUniqueOrThrow({ where: { id: providerId } })
  return p.saldo
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-jasa-'))
  const dbUrl = `file:${path.join(tmpDir, 'jasa.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const owner = await prisma.user.create({
    data: { name: 'Pemilik Jasa', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  ownerId = owner.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir Jasa', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'JASA-001',
      nama: 'Indomie Goreng',
      searchKey: 'indomie goreng jasa-001',
      kategori: 'Makanan',
      hargaJual: HARGA_JUAL,
      hargaBeli: HARGA_BELI,
      stok: STOK_AWAL,
      stokMinimum: 5,
    },
  })
  productId = product.id

  for (const [k, value] of Object.entries({
    storeName: 'Toko Jasa',
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
        // WAJIB: tanpa ini, backup startup dan backup tutup shift menulis
        // snapshot database UJI ke folder backups/ toko lalu memangkas backup
        // aslinya (tests/test-hygiene.test.ts).
        BACKUP_DIR: path.join(tmpDir, 'backups'),
        NEXT_DIST_DIR: '.next-jasa',
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

describe('provider: hanya pemilik yang boleh membuat akun uang', () => {
  let providerId = ''

  it('1. kasir DITOLAK membuat provider', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await api('POST', '/api/providers', {
      nama: 'Shopee',
      jenis: 'EWALLET',
      saldoAwal: 0,
    })
    // Role dicek server. Menyembunyikan menu bukan otorisasi.
    expect(res.status).toBe(403)
    expect(await prisma.serviceProvider.count()).toBe(0)
  }, 120_000)

  it('2. pemilik membuat provider dengan saldo awal', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const res = await api('POST', '/api/providers', {
      nama: 'Shopee',
      jenis: 'EWALLET',
      saldoAwal: SALDO_AWAL,
    })
    expect(res.status).toBe(201)
    providerId = String((res.data.provider as { id: string }).id)

    expect(await saldo(providerId)).toBe(SALDO_AWAL)

    // Saldo awal masuk lewat pergerakan, bukan ditulis langsung ke kolom —
    // invarian "saldo == Σ amountChange" berlaku sejak baris pertama.
    const movements = await prisma.providerBalanceMovement.findMany({ where: { providerId } })
    expect(movements).toHaveLength(1)
    expect(movements[0]?.reason).toBe('INITIAL')
    expect(movements[0]?.balanceAfter).toBe(SALDO_AWAL)
  }, 120_000)

  it('3. kasir BOLEH membaca daftar provider — saldo harus terlihat sebelum menjual', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await api('GET', '/api/providers')
    expect(res.status).toBe(200)
    const providers = res.data.providers as { nama: string; saldo: number }[]
    expect(providers).toHaveLength(1)
    expect(providers[0]?.saldo).toBe(SALDO_AWAL)
  }, 120_000)
})

describe('menjual jasa: tiga angka yang tidak boleh tertukar', () => {
  let providerId = ''
  let shiftId = ''

  it('4. siapkan shift dan ambil provider', async () => {
    providerId = (await prisma.serviceProvider.findFirstOrThrow()).id
    await loginAs(cashierId, CASHIER_PIN)
    const shift = await api('POST', '/api/shifts/open', { openingCash: KAS_AWAL })
    expect(shift.status).toBe(201)
    shiftId = String(shift.data.shiftId)
  }, 120_000)

  it('5. token listrik: omzet 2.500, laci +102.500, saldo provider −100.000', async () => {
    const res = await api('POST', '/api/transactions', {
      lines: [],
      services: [
        {
          kind: 'TOKEN_LISTRIK',
          providerId,
          passthroughAmount: 100_000,
          serviceFeeAmount: 2_500,
          customerRef: '14045678901',
        },
      ],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 105_000,
    })

    expect(res.status).toBe(201)
    expect(res.data.status).toBe('COMPLETED')

    // OMZET — ini yang masuk laporan penjualan.
    expect(res.data.netTotal).toBe(2_500)
    // TITIPAN — terpisah, tidak pernah dijumlahkan ke omzet.
    expect(res.data.passthroughTotal).toBe(100_000)
    // UANG YANG BERPINDAH — ini yang diucapkan kasir ke pelanggan.
    expect(res.data.payAmount).toBe(102_500)
    expect(res.data.changeAmount).toBe(2_500)

    const trx = await prisma.transaction.findUniqueOrThrow({
      where: { id: String(res.data.transactionId) },
      include: { payments: true, services: true },
    })
    expect(trx.netTotal).toBe(2_500)
    expect(trx.serviceFeeTotal).toBe(2_500)
    expect(trx.passthroughTotal).toBe(100_000)
    // Payment.amount = uang yang berpindah, BUKAN omzet.
    expect(trx.payments[0]?.amount).toBe(102_500)

    // Arah dan label datang dari katalog di server, bukan dari client.
    expect(trx.services[0]?.direction).toBe('PROVIDER_OUT')
    expect(trx.services[0]?.label).toBe('Token Listrik')
    expect(trx.services[0]?.providerName).toBe('Shopee')

    expect(await saldo(providerId)).toBe(SALDO_AWAL - 100_000)

    const gerak = await prisma.providerBalanceMovement.findFirstOrThrow({
      where: { reason: 'SERVICE', refId: trx.id },
    })
    expect(gerak.amountChange).toBe(-100_000)
    expect(gerak.balanceAfter).toBe(SALDO_AWAL - 100_000)
  }, 120_000)

  it('6. barang + jasa dalam SATU pembayaran', async () => {
    const saldoSebelum = await saldo(providerId)

    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 2, itemDiscount: 0 }],
      services: [
        { kind: 'EWALLET_TOPUP', providerId, passthroughAmount: 50_000, serviceFeeAmount: 2_000 },
      ],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 100_000,
    })

    expect(res.status).toBe(201)
    // Omzet: mie 7.000 + admin 2.000.
    expect(res.data.netTotal).toBe(9_000)
    expect(res.data.payAmount).toBe(59_000)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(STOK_AWAL - 2)
    expect(await saldo(providerId)).toBe(saldoSebelum - 50_000)
  }, 120_000)

  it('7. diskon transaksi atas keranjang jasa saja DITOLAK', async () => {
    const res = await api('POST', '/api/transactions', {
      lines: [],
      services: [
        { kind: 'PDAM', providerId, passthroughAmount: 80_000, serviceFeeAmount: 3_000 },
      ],
      transactionDiscount: 1_000,
      method: 'CASH',
      amountTendered: 90_000,
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/hanya berlaku untuk barang/i)
  }, 120_000)

  it('8. tarik tunai: uang KELUAR dari laci, saldo provider NAIK', async () => {
    const saldoSebelum = await saldo(providerId)

    const res = await api('POST', '/api/transactions', {
      lines: [],
      services: [
        {
          kind: 'TARIK_TUNAI',
          providerId,
          passthroughAmount: 200_000,
          serviceFeeAmount: 5_000,
        },
      ],
      transactionDiscount: 0,
      method: 'CASH_OUT',
    })

    expect(res.status).toBe(201)
    expect(res.data.netTotal).toBe(5_000) // omzet toko tetap positif
    expect(res.data.passthroughTotal).toBe(-200_000)
    expect(res.data.payDirection).toBe('OUT')
    expect(res.data.payAmount).toBe(195_000)

    // Saldo provider BERTAMBAH: pelanggan mentransfer ke rekening toko.
    expect(await saldo(providerId)).toBe(saldoSebelum + 200_000)

    const trx = await prisma.transaction.findUniqueOrThrow({
      where: { id: String(res.data.transactionId) },
      include: { payments: true },
    })
    expect(trx.payments[0]?.method).toBe('CASH_OUT')
    // Positif, walaupun uangnya keluar. Arahnya dinyatakan `method`, bukan tanda
    // angkanya — angka negatif akan menabrak assertRupiah di modul kas.
    expect(trx.payments[0]?.amount).toBe(195_000)
  }, 120_000)

  it('9. tarik tunai DICAMPUR barang ditolak 400, tanpa efek apa pun', async () => {
    const saldoSebelum = await saldo(providerId)
    const stokSebelum = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stok

    const res = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      services: [
        { kind: 'TARIK_TUNAI', providerId, passthroughAmount: 100_000, serviceFeeAmount: 5_000 },
      ],
      transactionDiscount: 0,
      method: 'CASH_OUT',
    })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/transaksi tersendiri/i)

    expect(await saldo(providerId)).toBe(saldoSebelum)
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(product.stok).toBe(stokSebelum)
  }, 120_000)

  it('10. metode bayar yang arahnya salah ditolak', async () => {
    // Tarik tunai dikirim dengan method CASH. Kalau lolos, uang keluar akan
    // dicatat sebagai uang MASUK sebesar nilai mutlaknya — laci toko bertambah
    // di atas kertas sebesar uang yang justru baru saja keluar.
    const res = await api('POST', '/api/transactions', {
      lines: [],
      services: [
        { kind: 'TARIK_TUNAI', providerId, passthroughAmount: 100_000, serviceFeeAmount: 5_000 },
      ],
      transactionDiscount: 0,
      method: 'CASH',
      amountTendered: 0,
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/serah tunai/i)
  }, 120_000)

  it('11. void transaksi jasa DITOLAK — titipannya sudah dibayarkan ke provider', async () => {
    const trx = await prisma.transaction.findFirstOrThrow({
      where: { status: 'COMPLETED', services: { some: {} } },
      orderBy: { createdAt: 'desc' },
    })

    const res = await api('POST', `/api/transactions/${trx.id}/void`, {
      ownerPin: OWNER_PIN,
      reason: 'Pelanggan berubah pikiran',
    })

    expect(res.status).toBe(409)
    // Pesannya harus menyebut jalur yang benar-benar tersedia. Sebelum bug
    // hunting ia menyuruh "gunakan refund", padahal refund atas transaksi jasa
    // murni mustahil — tidak ada baris barang untuk dipilih (BH-04).
    const pesan = JSON.stringify(res.data)
    expect(pesan).toMatch(/jasa/i)
    expect(pesan).not.toMatch(/refund/i)
    expect(pesan).toMatch(/pengeluaran kas/i)

    const sesudah = await prisma.transaction.findUniqueOrThrow({ where: { id: trx.id } })
    expect(sesudah.status).toBe('COMPLETED')
  }, 120_000)
})

describe('rekonsiliasi kas: top-up bukan pengeluaran', () => {
  let providerId = ''

  it('12. top-up dari laci mengurangi expected cash, tapi BUKAN pengeluaran', async () => {
    providerId = (await prisma.serviceProvider.findFirstOrThrow()).id
    await loginAs(cashierId, CASHIER_PIN)

    const sebelum = await api('GET', '/api/shifts/current')
    const kasSebelum = (sebelum.data.summary as { expectedCash: number }).expectedCash
    const saldoSebelum = await saldo(providerId)

    const res = await api('POST', `/api/providers/${providerId}/topup`, {
      amount: 300_000,
      paidFrom: 'CASH_DRAWER',
      note: 'Isi saldo dari laci',
    })
    expect(res.status).toBe(201)

    expect(await saldo(providerId)).toBe(saldoSebelum + 300_000)

    const sesudah = await api('GET', '/api/shifts/current')
    const ringkas = sesudah.data.summary as {
      expectedCash: number
      cashProviderTopups: number
      cashExpenses: number
    }

    // Laci berkurang…
    expect(ringkas.expectedCash).toBe(kasSebelum - 300_000)
    expect(ringkas.cashProviderTopups).toBe(300_000)
    // …tapi ini BUKAN pengeluaran. Kalau ia tercatat sebagai pengeluaran, laba
    // toko akan terlihat anjlok setiap kali pemilik mengisi saldo.
    expect(ringkas.cashExpenses).toBe(0)
    expect(await prisma.expense.count()).toBe(0)
  }, 120_000)

  it('13. top-up dari luar laci TIDAK mengurangi expected cash', async () => {
    const sebelum = await api('GET', '/api/shifts/current')
    const kasSebelum = (sebelum.data.summary as { expectedCash: number }).expectedCash
    const saldoSebelum = await saldo(providerId)

    const res = await api('POST', `/api/providers/${providerId}/topup`, {
      amount: 100_000,
      paidFrom: 'OTHER',
      note: 'Transfer dari rekening pemilik',
    })
    expect(res.status).toBe(201)

    expect(await saldo(providerId)).toBe(saldoSebelum + 100_000)

    const sesudah = await api('GET', '/api/shifts/current')
    expect((sesudah.data.summary as { expectedCash: number }).expectedCash).toBe(kasSebelum)
  }, 120_000)

  it('14. top-up diulang dengan kunci sama: saldo TIDAK naik dua kali', async () => {
    const saldoSebelum = await saldo(providerId)
    const k = kunci()
    const isi = { amount: 250_000, paidFrom: 'CASH_DRAWER', idempotencyKey: k }

    const a = await api('POST', `/api/providers/${providerId}/topup`, isi)
    const b = await api('POST', `/api/providers/${providerId}/topup`, isi)

    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(b.data.replayed).toBe(true)

    expect(await saldo(providerId)).toBe(saldoSebelum + 250_000)
    expect(
      await prisma.providerBalanceMovement.count({ where: { idempotencyKey: k } }),
    ).toBe(1)
  }, 120_000)

  it('15. top-up tanpa kunci ditolak 400, tanpa menyentuh saldo', async () => {
    const saldoSebelum = await saldo(providerId)

    const res = await fetch(`${baseUrl}/api/providers/${providerId}/topup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ amount: 50_000, paidFrom: 'CASH_DRAWER' }),
    })

    expect(res.status).toBe(400)
    expect(await saldo(providerId)).toBe(saldoSebelum)
  }, 120_000)

  it('16. penyesuaian saldo butuh PIN pemilik, dan kasir DITOLAK', async () => {
    const saldoSebelum = await saldo(providerId)

    const kasir = await api('POST', `/api/providers/${providerId}/adjustment`, {
      newBalance: 1,
      reason: 'Coba-coba',
      ownerPin: OWNER_PIN,
    })
    expect(kasir.status).toBe(403)

    await loginAs(ownerId, OWNER_PIN)
    const salahPin = await api('POST', `/api/providers/${providerId}/adjustment`, {
      newBalance: 1,
      reason: 'PIN salah',
      ownerPin: '000000',
    })
    expect([401, 403]).toContain(salahPin.status)

    expect(await saldo(providerId)).toBe(saldoSebelum)
  }, 120_000)

  it('17. penyesuaian saldo mencatat selisihnya, bukan menimpa diam-diam', async () => {
    const saldoSebelum = await saldo(providerId)
    const asli = saldoSebelum - 17_500

    const res = await api('POST', `/api/providers/${providerId}/adjustment`, {
      newBalance: asli,
      reason: 'Hasil cek saldo di aplikasi Shopee',
      ownerPin: OWNER_PIN,
    })
    expect(res.status).toBe(201)
    expect(res.data.amountChange).toBe(-17_500)

    expect(await saldo(providerId)).toBe(asli)

    const gerak = await prisma.providerBalanceMovement.findFirstOrThrow({
      where: { reason: 'ADJUSTMENT' },
      orderBy: { createdAt: 'desc' },
    })
    expect(gerak.balanceBefore).toBe(saldoSebelum)
    expect(gerak.balanceAfter).toBe(asli)
    expect(gerak.note).toMatch(/Shopee/)

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'PROVIDER_ADJUSTMENT' },
    })
    expect(audit.summary).toMatch(/Shopee/)
  }, 120_000)
})

describe('laporan: titipan tidak mencemari omzet', () => {
  it('18. laporan harian memisahkan omzet, titipan, dan uang yang berpindah', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const hari = hariUsaha()

    const res = await api('GET', `/api/reports/daily?date=${hari}`)
    expect(res.status).toBe(200)

    const a = res.data.aggregate as {
      netSales: number
      serviceFees: number
      passthroughOut: number
      passthroughIn: number
      serviceCount: number
      servicesByKind: { kind: string; passthrough: number; fee: number }[]
      providerBalances: { providerName: string; saldo: number }[]
    }

    // Omzet = mie + seluruh biaya admin. Titipan TIDAK ada di dalamnya.
    // 2.500 (token) + 9.000 (mie+topup) + 5.000 (tarik tunai) = 16.500
    expect(a.netSales).toBe(16_500)
    expect(a.serviceFees).toBe(9_500)
    expect(a.passthroughOut).toBe(150_000)
    expect(a.passthroughIn).toBe(200_000)
    expect(a.serviceCount).toBe(3)

    const jenis = a.servicesByKind.map((j) => j.kind).sort()
    expect(jenis).toEqual(['EWALLET_TOPUP', 'TARIK_TUNAI', 'TOKEN_LISTRIK'])

    expect(a.providerBalances[0]?.providerName).toBe('Shopee')
  }, 120_000)

  it('19. nomor pelanggan tidak ikut ke agregat laporan', async () => {
    // customerRef tersimpan di baris transaksi (pemilik butuh saat ada komplain),
    // tapi ia tidak punya jalur ke agregat — dan karena itu tidak punya jalur ke
    // payload AI maupun ke pesan laporan yang keluar dari jaringan toko.
    const hari = hariUsaha()
    const res = await api('GET', `/api/reports/daily?date=${hari}`)

    expect(JSON.stringify(res.data.aggregate)).not.toContain('14045678901')

    // Tapi datanya memang tersimpan.
    const jasa = await prisma.transactionService.findFirstOrThrow({
      where: { kind: 'TOKEN_LISTRIK' },
    })
    expect(jasa.customerRef).toBe('14045678901')
  }, 120_000)
})
