import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Fase 7 lewat HTTP: dashboard pemilik, kewajiban manual, backup, export.
 *
 * Yang diuji di sini justru sambungannya, bukan fungsi-fungsinya sendiri:
 *
 *  - transaksi QRIS yang dibatalkan otomatis saat tutup shift BENAR-BENAR muncul
 *    di dashboard sebagai "periksa mutasi rekening". Kalau kalimat penanda di
 *    penutupan shift berubah, daftar itu akan sunyi tanpa ada yang tahu — dan
 *    daftar yang sunyi terlihat sama seperti daftar yang kosong.
 *  - void atas QRIS yang sudah PAID muncul sebagai kewajiban mengembalikan uang.
 *  - ZIP hasil export benar-benar bisa dibuka Windows, dan TIDAK memuat pinHash.
 *  - kasir tidak bisa menyentuh backup maupun export.
 */

const OWNER_PIN = '246810'
const CASHIER_PIN = '111213'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let backupDir = ''
let mirrorDir = ''
let ownerId = ''
let cashierId = ''
let productId = ''
let cookie = ''

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

const PREFIX_KUNCI = '88888888-8888-4888-8888'

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

async function html(pathname: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'manual',
  })
  return { status: res.status, body: await res.text() }
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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-f7-'))
  backupDir = path.join(tmpDir, 'backups')
  mirrorDir = path.join(tmpDir, 'mirror')
  fs.mkdirSync(mirrorDir, { recursive: true })
  const dbUrl = `file:${path.join(tmpDir, 'f7.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const owner = await prisma.user.create({
    data: { name: 'Pemilik F7', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  ownerId = owner.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir F7', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  const product = await prisma.product.create({
    data: {
      sku: 'F7-001',
      barcode: '7770000000077',
      nama: 'Produk F7',
      searchKey: 'produk f7 f7-001',
      kategori: 'Uji',
      hargaJual: 15_000,
      hargaBeli: 10_000,
      stok: 100,
      stokMinimum: 5,
    },
  })
  productId = product.id

  // QRIS diaktifkan lewat setting supaya checkout QRIS tidak ditolak provider.
  for (const [key, value] of Object.entries({
    storeName: 'Toko Fase 7',
    timezone: 'Asia/Jakarta',
    expenseCategories: JSON.stringify(['Operasional']),
    qrisEnabled: 'true',
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
        // Folder backup sendiri: berkas berisi data UJI tidak boleh masuk folder
        // backup toko, karena di sana ia tidak bisa dibedakan dari yang asli.
        BACKUP_DIR: backupDir,
        BACKUP_MIRROR_DIR: mirrorDir,
        BACKUP_KEEP: '5',
        NEXT_DIST_DIR: '.next-f7',
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

describe('kewajiban manual di dashboard pemilik', () => {
  let trxDibatalkan = ''
  let trxVoid = ''

  it('1. pembayaran terlantar → shift ditutup → transaksinya dibatalkan otomatis', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const shift = await api('POST', '/api/shifts/open', { openingCash: 50_000 })
    expect(shift.status).toBe(201)
    const shiftId = String(shift.data.shiftId)

    // Dulu baris PENDING ini dibuat lewat layar kasir: checkout QRIS berhenti
    // di PENDING sampai kasir menekan tombol kedua. Dengan QRIS soundbox,
    // checkout selesai dalam satu langkah, jadi layar kasir tidak lagi bisa
    // menghasilkannya.
    //
    // Mekanisme auto-cancel-nya TETAP diuji, dan barisnya dibuat langsung di
    // database — persis seperti yang akan dilakukan webhook provider dinamis
    // nanti, dan persis seperti baris lama yang mungkin masih tersisa di
    // database toko. Menghapus test ini karena jalurnya berubah akan membuat
    // penutupan shift berhenti dijaga tanpa ada yang menyadarinya.
    trxDibatalkan = 'TRX-TERLANTAR-001'
    await prisma.transaction.create({
      data: {
        trxNumber: trxDibatalkan,
        businessDate: hariUsaha(),
        shiftId,
        cashierId,
        status: 'PENDING',
        grossSubtotal: 30_000,
        itemDiscountTotal: 0,
        transactionDiscount: 0,
        netTotal: 30_000,
        cogsTotal: 0,
        payments: {
          create: [
            {
              method: 'QRIS_STATIC',
              status: 'PENDING',
              amount: 30_000,
              providerName: 'qris-static',
            },
          ],
        },
      },
    })

    // Penutupan shift TIDAK boleh diblokir oleh transaksi terlantar.
    const tutup = await api('POST', `/api/shifts/${shiftId}/close`, { countedCash: 50_000 })
    expect(tutup.status).toBe(200)

    const trx = await prisma.transaction.findFirstOrThrow({
      where: { trxNumber: trxDibatalkan },
    })
    expect(trx.status).toBe('CANCELLED')
  }, 120_000)

  it('2. QRIS dibayar lalu di-void → kewajiban mengembalikan uang', async () => {
    const shift = await api('POST', '/api/shifts/open', { openingCash: 50_000 })
    expect(shift.status).toBe(201)

    const qris = await api('POST', '/api/transactions', {
      lines: [{ productId, qty: 1, itemDiscount: 0 }],
      transactionDiscount: 0,
      method: 'QRIS_STATIC',
    })
    expect(qris.status).toBe(201)
    // Satu langkah: kasir menekan QRIS setelah soundbox berbunyi, dan
    // transaksinya langsung lunas. Tidak ada lagi request konfirmasi kedua.
    expect(qris.data.status).toBe('COMPLETED')
    trxVoid = String(qris.data.trxNumber)

    const trxId = String(qris.data.transactionId)
    const batal = await api('POST', `/api/transactions/${trxId}/void`, {
      ownerPin: OWNER_PIN,
      reason: 'Pelanggan membatalkan setelah bayar',
    })
    expect(batal.status).toBe(200)
  }, 120_000)

  it('3. dashboard memuat KEDUA kewajiban itu, dengan kalimat tindakannya', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const page = await html('/dashboard')

    expect(page.status).toBe(200)
    expect(page.body).toContain('Butuh tindakan Anda')

    // Kewajiban 1: periksa mutasi rekening.
    expect(page.body).toContain(trxDibatalkan)
    expect(page.body).toContain('Periksa mutasi rekening')

    // Kewajiban 2: uang QRIS sudah masuk, kembalikan manual.
    expect(page.body).toContain(trxVoid)
    expect(page.body).toContain('Uang QRIS sudah masuk rekening')
  }, 120_000)

  it('4. kasir tidak bisa membuka dashboard', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const page = await html('/dashboard')
    // Next.js menjawab redirect ke /kasir untuk role yang bukan OWNER.
    expect([302, 303, 307]).toContain(page.status)
  }, 60_000)
})

describe('backup dari halaman pemilik', () => {
  it('5. kasir DITOLAK menjalankan backup', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await api('POST', '/api/backup', {})
    expect(res.status).toBe(403)
  }, 60_000)

  it('6. pemilik menjalankan backup: berkasnya dibuat DAN terverifikasi', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const res = await api('POST', '/api/backup', {})

    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)

    const v = res.data.verification as {
      ok: boolean
      integrity: string
      transactionCount: number
    }
    expect(v.ok).toBe(true)
    expect(v.integrity).toBe('ok')
    // Dua transaksi dibuat di blok sebelumnya; keduanya harus ada DI DALAM backup.
    expect(v.transactionCount).toBe(2)

    // Berkasnya benar-benar ada di folder yang dipakai server.
    const file = String(res.data.file)
    expect(fs.existsSync(path.join(backupDir, file))).toBe(true)
    // Dan sudah tersalin ke folder cadangan, karena verifikasinya lulus.
    expect(fs.existsSync(path.join(mirrorDir, file))).toBe(true)
  }, 120_000)

  it('7. hasilnya tercatat di audit log sebagai BACKUP_RUN dengan pelaku', async () => {
    const baris = await prisma.auditLog.findMany({
      where: { action: 'BACKUP_RUN' },
      orderBy: { at: 'desc' },
      take: 5,
    })
    expect(baris.length).toBeGreaterThan(0)
    expect(baris.some((b) => b.userId === ownerId)).toBe(true)
  }, 60_000)
})

describe('export CSV', () => {
  it('8. kasir DITOLAK mengunduh export', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await fetch(`${baseUrl}/api/export/csv`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(403)
  }, 60_000)

  it('9. pemilik mendapat ZIP yang sah, tanpa pinHash di dalamnya', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const res = await fetch(`${baseUrl}/api/export/csv`, { headers: { Cookie: cookie } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-disposition')).toContain('export-toko-')

    const buffer = Buffer.from(await res.arrayBuffer())

    // Signature ZIP.
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    const teks = buffer.toString('latin1')
    expect(teks).toContain('transactions.csv')
    expect(teks).toContain('products.csv')
    expect(teks).toContain('audit_logs.csv')
    expect(teks).toContain('BACA-DULU.txt')

    // Yang TIDAK boleh ada. Berkas export sering berpindah lewat WhatsApp.
    expect(teks).not.toContain('pinHash')
    expect(teks).not.toContain('settings.csv')

    fs.writeFileSync(path.join(tmpDir, 'export.zip'), buffer)
  }, 120_000)

  it('10. Windows sendiri bisa membuka ZIP-nya', async () => {
    // Bukti terkuat yang bisa diberikan test untuk penulis ZIP buatan sendiri:
    // bukan "strukturnya sesuai bacaan saya", tapi "sistem operasi yang akan
    // dipakai pemilik benar-benar membukanya".
    if (process.platform !== 'win32') {
      expect(true).toBe(true)
      return
    }

    const zipPath = path.join(tmpDir, 'export.zip')
    const outDir = path.join(tmpDir, 'keluar')
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`,
      ],
      { stdio: 'pipe' },
    )

    const isi = fs.readdirSync(outDir).sort()
    expect(isi).toContain('transactions.csv')
    expect(isi).toContain('users.csv')
    expect(isi).toContain('BACA-DULU.txt')

    // Isi CSV-nya harus benar-benar terbaca, bukan sekadar berkasnya ada.
    const users = fs.readFileSync(path.join(outDir, 'users.csv'), 'utf8')
    expect(users).toContain('Pemilik F7')
    expect(users).not.toContain('pinHash')

    const transactions = fs.readFileSync(path.join(outDir, 'transactions.csv'), 'utf8')
    expect(transactions.split('\r\n')[0]).toContain('trxNumber')
    expect(transactions).toContain('CANCELLED')
    expect(transactions).toContain('VOIDED')
  }, 120_000)
})
