import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { createLogger } from '../logger'

const log = createLogger('backup')

const BACKUP_PREFIX = 'pos-'
const BACKUP_RE = /^pos-\d{8}-\d{6}\.db$/

export interface BackupResult {
  ok: boolean
  file: string | null
  sizeBytes: number | null
  prunedCount: number
  mirroredTo: string | null
  error: string | null
}

/** pos-20260918-214530.db — bisa diurutkan secara leksikal. */
function backupFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const y = now.getFullYear()
  const stamp = `${y}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(
    now.getMinutes(),
  )}${p(now.getSeconds())}`
  return `${BACKUP_PREFIX}${stamp}.db`
}

/**
 * SQLite menerima path dengan forward slash di semua platform, termasuk Windows.
 * Kutip tunggal di dalam path di-escape dengan menggandakannya.
 */
function toSqliteLiteral(absolutePath: string): string {
  return absolutePath.split(path.sep).join('/').replace(/'/g, "''")
}

/**
 * Backup database memakai `VACUUM INTO`, BUKAN menyalin file.
 *
 * Alasannya penting: dengan journal_mode=WAL, sebagian transaksi terbaru masih
 * berada di file `pos.db-wal` dan belum tergabung ke `pos.db`. Menyalin
 * `pos.db` mentah saat kasir sedang menulis bisa menghasilkan backup yang rusak
 * atau kehilangan transaksi terakhir. `VACUUM INTO` menghasilkan snapshot
 * konsisten satu file tanpa menghentikan penulisan.
 *
 * Fungsi ini TIDAK PERNAH melempar. Gagal backup harus terlihat di log dan
 * dashboard, tapi tidak boleh menghentikan server atau menggagalkan tutup shift.
 */
export async function runBackup(now: Date = new Date()): Promise<BackupResult> {
  const result: BackupResult = {
    ok: false,
    file: null,
    sizeBytes: null,
    prunedCount: 0,
    mirroredTo: null,
    error: null,
  }

  try {
    fs.mkdirSync(config.paths.backups, { recursive: true })

    // VACUUM INTO menolak menulis kalau file tujuan sudah ada. Nama bercap
    // detik sudah cukup unik, tapi dua pemicu di detik yang sama (startup dan
    // tutup shift) mungkin bertemu — jadi tambahkan suffix kalau perlu.
    let fileName = backupFileName(now)
    let target = path.join(config.paths.backups, fileName)
    let suffix = 1
    while (fs.existsSync(target)) {
      fileName = backupFileName(now).replace(/\.db$/, `-${suffix}.db`)
      target = path.join(config.paths.backups, fileName)
      suffix++
      if (suffix > 50) throw new Error('tidak bisa menemukan nama file backup yang bebas')
    }

    await prisma.$executeRawUnsafe(`VACUUM INTO '${toSqliteLiteral(target)}'`)

    const stat = fs.statSync(target)
    result.ok = true
    result.file = fileName
    result.sizeBytes = stat.size

    result.prunedCount = pruneBackups(config.backup.keep)
    result.mirroredTo = mirrorBackup(target)

    log.info('backup selesai', {
      file: fileName,
      sizeKb: Math.round(stat.size / 1024),
      pruned: result.prunedCount,
      mirroredTo: result.mirroredTo,
    })
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    log.error('backup GAGAL', e)
  }

  return result
}

/** Sisakan `keep` file terbaru, hapus sisanya. Mengembalikan jumlah terhapus. */
export function pruneBackups(keep: number): number {
  try {
    const files = fs
      .readdirSync(config.paths.backups)
      .filter((n) => BACKUP_RE.test(n) || n.startsWith(BACKUP_PREFIX))
      .filter((n) => n.endsWith('.db'))
      .sort() // nama bercap tanggal → urutan leksikal == urutan waktu

    const excess = files.length - keep
    if (excess <= 0) return 0

    let removed = 0
    for (const name of files.slice(0, excess)) {
      try {
        fs.unlinkSync(path.join(config.paths.backups, name))
        removed++
      } catch {
        // File terkunci (misalnya sedang dibuka antivirus) dilewati saja.
      }
    }
    return removed
  } catch (e) {
    log.warn('prune backup gagal', { error: e instanceof Error ? e.message : String(e) })
    return 0
  }
}

/**
 * Salin backup terbaru ke folder cadangan (USB / folder cloud tersinkron).
 *
 * Backup di disk yang sama TIDAK melindungi dari disk rusak, laptop hilang,
 * atau ransomware. Karena itu mirror ini ada — opsional, tapi sangat disarankan.
 */
function mirrorBackup(sourcePath: string): string | null {
  const dir = config.backup.mirrorDir
  if (!dir) return null

  try {
    if (!fs.existsSync(dir)) {
      // Folder mirror sering berupa USB yang sedang dicabut. Itu kondisi normal,
      // bukan error — cukup catat dan lanjut.
      log.warn('folder mirror backup tidak ditemukan, dilewati', { dir })
      return null
    }
    const target = path.join(dir, path.basename(sourcePath))
    fs.copyFileSync(sourcePath, target)
    return target
  } catch (e) {
    log.warn('mirror backup gagal', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export interface BackupInfo {
  file: string
  sizeBytes: number
  modifiedAt: Date
}

/** Daftar backup yang ada, terbaru lebih dulu. Untuk dashboard dan health. */
export function listBackups(): BackupInfo[] {
  try {
    return fs
      .readdirSync(config.paths.backups)
      .filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith('.db'))
      .map((file) => {
        const stat = fs.statSync(path.join(config.paths.backups, file))
        return { file, sizeBytes: stat.size, modifiedAt: stat.mtime }
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
  } catch {
    return []
  }
}
