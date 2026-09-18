import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { config } from '../config'
import { createLogger } from '../logger'

const log = createLogger('db')

/**
 * Prisma client singleton.
 *
 * Pola globalThis wajib: tanpa ini, HMR di `next dev` membuat client baru setiap
 * kali file berubah, dan puluhan koneksi ke satu file SQLite akan berujung
 * SQLITE_BUSY saat dua kasir checkout bersamaan.
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
  pragmaApplied?: boolean
}

function createClient(): PrismaClient {
  // Pastikan folder data/ ada sebelum SQLite mencoba membuka filenya.
  fs.mkdirSync(config.paths.data, { recursive: true })

  return new PrismaClient({
    log: config.isProduction ? ['error'] : ['error', 'warn'],
  })
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient()

if (!config.isProduction) {
  globalForPrisma.prisma = prisma
}

/**
 * PRAGMA SQLite yang menentukan apakah sistem ini tahan dipakai beberapa kasir
 * sekaligus. Dijalankan sekali per proses, sebelum query apa pun.
 *
 * docs/architecture.md §6.1
 */
export async function applyPragmas(): Promise<void> {
  if (globalForPrisma.pragmaApplied) return

  // foreign_keys: SQLite mematikannya SECARA DEFAULT. Tanpa baris ini seluruh
  // relasi di schema hanya dekorasi dan data yatim bisa masuk.
  //
  // journal_mode=WAL: banyak reader + satu writer tanpa saling blokir total.
  // Ini yang membuat kasir B bisa membaca daftar produk sementara kasir A
  // sedang commit checkout.
  //
  // busy_timeout: tunggu 5 detik alih-alih langsung melempar SQLITE_BUSY saat
  // dua checkout bertabrakan.
  //
  // synchronous=NORMAL: aman dipasangkan dengan WAL, jauh lebih cepat dari FULL.
  const statements = [
    'PRAGMA foreign_keys = ON',
    'PRAGMA journal_mode = WAL',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA synchronous = NORMAL',
  ]

  for (const sql of statements) {
    // journal_mode mengembalikan baris hasil, jadi pakai queryRaw untuk semua
    // supaya tidak ada yang gagal karena dianggap non-query.
    await prisma.$queryRawUnsafe(sql)
  }

  const [mode] = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>(
    'PRAGMA journal_mode',
  )
  const [fk] = await prisma.$queryRawUnsafe<{ foreign_keys: number | bigint }[]>(
    'PRAGMA foreign_keys',
  )

  // SQLite mengembalikan nilai PRAGMA integer sebagai BigInt lewat Prisma.
  // `1n !== 1` bernilai true di JavaScript, jadi membandingkannya langsung akan
  // selalu melaporkan "tidak aktif" walaupun sebenarnya aktif. Dua hal ikut
  // rusak karena ini: pengecekan di bawah, dan JSON.stringify yang melempar
  // pada BigInt sehingga baris log jadi tidak terbaca.
  const journalMode = mode?.journal_mode?.toLowerCase() ?? 'unknown'
  const foreignKeys = fk === undefined ? -1 : Number(fk.foreign_keys)

  globalForPrisma.pragmaApplied = true
  log.info('PRAGMA diterapkan', { journal_mode: journalMode, foreign_keys: foreignKeys })

  // Kalau WAL gagal diaktifkan, beberapa kasir sekaligus akan sering bentrok.
  // Itu bukan alasan menolak jualan, tapi harus terlihat di log.
  if (journalMode !== 'wal') {
    log.warn('journal_mode BUKAN wal — concurrency antar-kasir akan lebih sering bentrok', {
      actual: journalMode,
    })
  }
  if (foreignKeys !== 1) {
    log.warn('foreign_keys TIDAK aktif — integritas relasi tidak ditegakkan database', {
      actual: foreignKeys,
    })
  }
}
