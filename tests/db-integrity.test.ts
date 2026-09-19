import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test terhadap file SQLite sementara — BUKAN data/pos.db.
 *
 * Yang diuji di sini adalah janji yang paling mudah dilanggar tanpa terasa:
 * apakah SQLite benar-benar menegakkan foreign key, dan apakah WAL aktif.
 * Keduanya tidak bisa dibuktikan dengan membaca kode; hanya database yang
 * berjalan bisa menjawabnya.
 *
 * Latar: pengecekan pertama untuk ini melaporkan "foreign_keys TIDAK aktif"
 * padahal aktif, karena PRAGMA SQLite dikembalikan sebagai BigInt dan
 * `1n !== 1` bernilai true. Test ini memastikan kesimpulannya ditarik dari
 * perilaku nyata, bukan dari perbandingan nilai yang bisa menipu.
 */

let prisma: PrismaClient
let tmpDir: string
let dbPath: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-test-'))
  dbPath = path.join(tmpDir, 'test.db')

  // Bangun skema di DB sementara lewat `prisma db push`.
  //
  // Dipanggil sebagai skrip Node langsung, bukan lewat `npx`: sejak Node 20,
  // spawn file .cmd tanpa shell ditolak (EINVAL), dan mengaktifkan shell
  // membawa masalah quoting karena path project ini mengandung spasi.
  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: 'pipe',
    },
  )

  prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbPath}?connection_limit=1` } },
  })
}, 120_000)

afterAll(async () => {
  await prisma?.$disconnect()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan; bukan kegagalan test.
  }
})

describe('PRAGMA', () => {
  it('foreign_keys terbaca aktif — dibandingkan sebagai angka, bukan BigInt', async () => {
    const rows =
      await prisma.$queryRawUnsafe<{ foreign_keys: number | bigint }[]>('PRAGMA foreign_keys')
    const value = rows[0]?.foreign_keys

    // Inilah jebakannya: nilainya BigInt, jadi perbandingan langsung gagal.
    expect(Number(value)).toBe(1)
  })

  it('journal_mode bisa diset ke WAL dan bertahan', async () => {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL')
    const rows = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode')
    expect(rows[0]?.journal_mode.toLowerCase()).toBe('wal')
  })
})

describe('foreign key ditegakkan database, bukan hanya digambar di schema', () => {
  it('menolak stock_movement dengan productId yang tidak ada', async () => {
    await expect(
      prisma.stockMovement.create({
        data: {
          productId: '00000000-0000-0000-0000-000000000000',
          qtyChange: -1,
          reason: 'SALE',
          stockBefore: 0,
          stockAfter: -1,
          userId: 'tidak-ada',
          businessDate: '2026-09-18',
        },
      }),
    ).rejects.toThrow()
  })

  it('menolak transaksi dengan shiftId yang tidak ada', async () => {
    await expect(
      prisma.transaction.create({
        data: {
          trxNumber: 'TRX-20260918-000001',
          businessDate: '2026-09-18',
          shiftId: 'tidak-ada',
          cashierId: 'tidak-ada',
          status: 'PENDING',
          grossSubtotal: 0,
          itemDiscountTotal: 0,
          transactionDiscount: 0,
          netTotal: 0,
          cogsTotal: 0,
        },
      }),
    ).rejects.toThrow()
  })
})

describe('constraint unik yang menopang aturan bisnis', () => {
  it('openKey mencegah dua shift OPEN untuk kasir yang sama', async () => {
    const user = await prisma.user.create({
      data: { name: 'Kasir Uji', role: 'CASHIER', pinHash: 'x' },
    })

    await prisma.shift.create({
      data: {
        cashierId: user.id,
        status: 'OPEN',
        openKey: user.id,
        openingCash: 100_000,
        businessDate: '2026-09-18',
      },
    })

    // Shift OPEN kedua untuk kasir yang sama harus ditolak DATABASE, bukan
    // hanya dicegah kode aplikasi — dua device yang menekan "Buka shift"
    // bersamaan tidak boleh lolos keduanya.
    await expect(
      prisma.shift.create({
        data: {
          cashierId: user.id,
          status: 'OPEN',
          openKey: user.id,
          openingCash: 50_000,
          businessDate: '2026-09-18',
        },
      }),
    ).rejects.toThrow()

    // Tapi shift CLOSED sebanyak apa pun tidak bertabrakan, karena openKey null
    // dan SQLite mengizinkan banyak NULL pada kolom unique.
    for (let i = 0; i < 3; i++) {
      await prisma.shift.create({
        data: {
          cashierId: user.id,
          status: 'CLOSED',
          openKey: null,
          openingCash: 0,
          countedCash: 0,
          expectedCash: 0,
          difference: 0,
          businessDate: '2026-09-17',
        },
      })
    }
    const closed = await prisma.shift.count({ where: { status: 'CLOSED' } })
    expect(closed).toBe(3)
  })

  it('dedupeKey mencegah kirim ganda AUTO tapi mengizinkan MANUAL berulang', async () => {
    // AUTO: satu per (kind, periodKey, channel) — penjaga anti-kirim-ganda
    // saat catch-up.
    await prisma.reportDelivery.create({
      data: {
        kind: 'DAILY',
        periodKey: '2026-09-17',
        channel: 'DISCORD',
        trigger: 'AUTO',
        status: 'SENT',
        dedupeKey: 'DAILY|2026-09-17|DISCORD',
      },
    })

    await expect(
      prisma.reportDelivery.create({
        data: {
          kind: 'DAILY',
          periodKey: '2026-09-17',
          channel: 'DISCORD',
          trigger: 'AUTO',
          status: 'PENDING',
          dedupeKey: 'DAILY|2026-09-17|DISCORD',
        },
      }),
    ).rejects.toThrow()

    // MANUAL: dedupeKey null, jadi menekan "Kirim laporan sekarang" berkali-kali
    // harus berhasil — bukan melempar error constraint.
    for (let i = 0; i < 3; i++) {
      await prisma.reportDelivery.create({
        data: {
          kind: 'DAILY',
          periodKey: '2026-09-17',
          channel: 'DISCORD',
          trigger: 'MANUAL',
          status: 'SENT',
          dedupeKey: null,
        },
      })
    }

    const manual = await prisma.reportDelivery.count({ where: { trigger: 'MANUAL' } })
    expect(manual).toBe(3)
  })
})

describe('invariant stok', () => {
  it('stok produk == Σ qtyChange sepanjang riwayat', async () => {
    const owner = await prisma.user.create({
      data: { name: 'Pemilik Uji', role: 'OWNER', pinHash: 'x' },
    })
    const product = await prisma.product.create({
      data: {
        sku: 'UJI-001',
        nama: 'Produk Uji',
        searchKey: 'produk uji uji-001',
        kategori: 'Uji',
        hargaBeli: 1000,
        hargaJual: 1500,
        stok: 0,
        stokMinimum: 0,
      },
    })

    const changes = [10, -3, 5, -1]
    let running = 0
    for (const qtyChange of changes) {
      const before = running
      running += qtyChange
      await prisma.stockMovement.create({
        data: {
          productId: product.id,
          qtyChange,
          reason: qtyChange > 0 ? 'PURCHASE' : 'SALE',
          stockBefore: before,
          stockAfter: running,
          userId: owner.id,
          businessDate: '2026-09-18',
        },
      })
    }
    await prisma.product.update({ where: { id: product.id }, data: { stok: running } })

    const movements = await prisma.stockMovement.findMany({ where: { productId: product.id } })
    const sum = movements.reduce((acc, m) => acc + m.qtyChange, 0)
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })

    expect(sum).toBe(11)
    expect(fresh.stok).toBe(sum)
    // stockAfter tiap baris konsisten dengan stockBefore + qtyChange
    for (const m of movements) {
      expect(m.stockAfter).toBe(m.stockBefore + m.qtyChange)
    }
  })
})
