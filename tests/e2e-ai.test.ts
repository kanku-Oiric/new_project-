import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `/api/ai/insight` lewat HTTP, dengan AI dalam keadaan DEFAULT: mati.
 *
 * Yang diuji di sini tidak bisa dilihat lapisan service: gerbang role, penolakan
 * Zod atas `kind: DAILY`, dan apa yang benar-benar dirender halaman laporan saat
 * fiturnya mati. Kalimat di layar itu adalah satu-satunya hal yang dibaca pemilik
 * toko, dan ia harus jujur — bukan "sedang menyiapkan analisis" untuk fitur yang
 * memang tidak menyala.
 */

const OWNER_PIN = '246810'
const CASHIER_PIN = '111213'

let prisma: PrismaClient
let server: ChildProcess | null = null
let baseUrl = ''
let tmpDir = ''
let ownerId = ''
let cashierId = ''
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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-ai-http-'))
  const dbUrl = `file:${path.join(tmpDir, 'ai.db')}?connection_limit=1`

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )

  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  const owner = await prisma.user.create({
    data: { name: 'Pemilik AI', role: 'OWNER', pinHash: await bcrypt.hash(OWNER_PIN, 10) },
  })
  ownerId = owner.id
  const cashier = await prisma.user.create({
    data: { name: 'Kasir AI', role: 'CASHIER', pinHash: await bcrypt.hash(CASHIER_PIN, 10) },
  })
  cashierId = cashier.id

  for (const [key, value] of Object.entries({
    storeName: 'Toko AI',
    timezone: 'Asia/Jakarta',
    expenseCategories: JSON.stringify(['Operasional']),
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
        // Keadaan default sistem. Kuncinya DIISI dengan sengaja: kalau suatu hari
        // gerbangnya berubah menjadi "ada kunci berarti nyala", test ini merah.
        AI_ENABLED: 'false',
        GEMINI_API_KEY: 'kunci-yang-tidak-boleh-dipakai',
        BACKUP_DIR: path.join(tmpDir, 'backups'),
        NEXT_DIST_DIR: '.next-ai',
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

describe('POST /api/ai/insight', () => {
  it('kasir DITOLAK', async () => {
    await loginAs(cashierId, CASHIER_PIN)
    const res = await api('POST', '/api/ai/insight', { kind: 'WEEKLY', periodKey: '2026-W38' })
    expect(res.status).toBe(403)
  }, 120_000)

  it('tanpa login DITOLAK', async () => {
    const res = await fetch(`${baseUrl}/api/ai/insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'WEEKLY', periodKey: '2026-W38' }),
    })
    expect([401, 403]).toContain(res.status)
  }, 60_000)

  it('kind DAILY ditolak 400 oleh skema, bukan diproses lalu ditolak nanti', async () => {
    await loginAs(ownerId, OWNER_PIN)
    const res = await api('POST', '/api/ai/insight', { kind: 'DAILY', periodKey: '2026-09-18' })
    expect(res.status).toBe(400)
  }, 60_000)

  it('periodKey yang tidak cocok dengan kind ditolak 400', async () => {
    const res = await api('POST', '/api/ai/insight', { kind: 'WEEKLY', periodKey: '2026-09-18' })
    expect(res.status).toBe(400)
  }, 60_000)

  it('pemilik mendapat status DISABLED, bukan error', async () => {
    const res = await api('POST', '/api/ai/insight', { kind: 'WEEKLY', periodKey: '2026-W38' })

    expect(res.status).toBe(200)
    expect(res.data.status).toBe('DISABLED')
    expect(res.data.text).toBeNull()
    expect(String(res.data.message)).toContain('dimatikan')
  }, 60_000)

  it('permintaannya tercatat di audit log walau AI mati', async () => {
    // Pertanyaan "siapa yang pernah mengirim data toko ke layanan luar, dan
    // kapan" harus bisa dijawab — termasuk saat jawabannya "tidak pernah".
    const baris = await prisma.auditLog.findFirst({
      where: { action: 'AI_INSIGHT_REQUEST' },
      orderBy: { at: 'desc' },
    })
    expect(baris).not.toBeNull()
    expect(baris?.userId).toBe(ownerId)
    expect(baris?.summary).toContain('DISABLED')
  }, 60_000)

  it('tidak ada baris ai_call_logs maupun ai_insights yang tertulis', async () => {
    expect(await prisma.aiCallLog.count()).toBe(0)
    expect(await prisma.aiInsight.count()).toBe(0)
  }, 60_000)
})

describe('halaman laporan saat AI mati', () => {
  it('laporan mingguan menampilkan bahwa analisis dimatikan, apa adanya', async () => {
    const res = await fetch(`${baseUrl}/laporan?kind=WEEKLY&period=2026-W38`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)

    const html = await res.text()
    expect(html).toContain('Analisis AI')
    expect(html).toContain('Dimatikan')
    // Tidak mengklaim sesuatu yang tidak ada.
    expect(html).not.toContain('Meminta analisis…')
  }, 120_000)

  it('laporan harian tidak menampilkan bagian analisis sama sekali', async () => {
    const res = await fetch(`${baseUrl}/laporan?kind=DAILY&period=2026-09-18`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('Analisis AI')
  }, 60_000)

  it('kunci API tidak pernah ikut ke HTML yang dikirim ke browser', async () => {
    for (const url of ['/laporan?kind=WEEKLY&period=2026-W38', '/dashboard', '/pengaturan']) {
      const res = await fetch(`${baseUrl}${url}`, { headers: { Cookie: cookie } })
      const html = await res.text()
      expect(html, `kunci API bocor di ${url}`).not.toContain('kunci-yang-tidak-boleh-dipakai')
    }
  }, 120_000)
})
