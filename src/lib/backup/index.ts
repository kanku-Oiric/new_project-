import fs from 'node:fs'
import path from 'node:path'
import { recordAuditSafe } from '../audit'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { createLogger } from '../logger'

const log = createLogger('backup')

const BACKUP_PREFIX = 'pos-'

export interface BackupResult {
  ok: boolean
  file: string | null
  sizeBytes: number | null
  prunedCount: number
  mirroredTo: string | null
  error: string | null
  verification: BackupVerification
}

export interface BackupVerification {
  /** Lulus `integrity_check` DAN bisa dibaca tabel transaksinya. */
  ok: boolean
  /** Hasil mentah `PRAGMA integrity_check` — "ok" kalau sehat. */
  integrity: string | null
  /** Jumlah baris transaksi DI DALAM berkas backup, bukan di database aktif. */
  transactionCount: number | null
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
 * Bentuk URI `file:...?mode=ro`, satu-satunya cara membuka berkas SQLite
 * benar-benar read-only.
 *
 * `?` dan `#` di dalam path harus di-escape: keduanya punya arti khusus di URI,
 * dan tanpa ini nama folder yang memuatnya akan membuat SQLite membaca separuh
 * path sebagai parameter.
 */
function toReadOnlyUri(absolutePath: string): string {
  const slashed = absolutePath.split(path.sep).join('/').replace(/\?/g, '%3f').replace(/#/g, '%23')
  return `file:${slashed.replace(/'/g, "''")}?mode=ro`
}

/**
 * Periksa berkas backup yang baru dibuat.
 *
 * "Backup ada" dan "backup bisa dipakai" adalah dua hal berbeda. Backup yang
 * belum pernah dibuka bukan strategi pemulihan, ia baru sebuah berkas — dan
 * kalau ia rusak, satu-satunya saat kita akan tahu adalah saat toko sedang
 * membutuhkannya.
 *
 * Dibuka lewat `ATTACH ... 'file:...?mode=ro'`, jadi pemeriksaan ini MUSTAHIL
 * merusak berkas yang sedang diperiksa. Tanpa `mode=ro`, SQLite berhak menulis
 * ke berkas itu (pemulihan WAL, misalnya) dan alat pemeriksa berubah menjadi
 * alat yang mengubah barang bukti.
 *
 * Tidak pernah melempar: gagal verifikasi bukan alasan menggagalkan backup —
 * berkasnya tetap ada, statusnya saja yang jadi "tidak terverifikasi".
 */
export async function verifyBackup(absolutePath: string): Promise<BackupVerification> {
  const result: BackupVerification = {
    ok: false,
    integrity: null,
    transactionCount: null,
    error: null,
  }

  let attached = false
  try {
    await prisma.$executeRawUnsafe(`ATTACH DATABASE '${toReadOnlyUri(absolutePath)}' AS verifikasi`)
    attached = true

    // Nama kolomnya `integrity_check`, tapi dibaca lewat nilai pertama baris
    // pertama supaya tidak bergantung pada nama itu.
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      'PRAGMA verifikasi.integrity_check',
    )
    const first = rows[0]
    const integrity = first ? String(Object.values(first)[0] ?? '') : ''
    result.integrity = integrity

    // Hitungan baris membuktikan isinya benar-benar terbaca, bukan cuma header
    // yang utuh. COUNT di SQLite kembali sebagai BigInt lewat query mentah.
    const counted = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
      'SELECT COUNT(*) AS n FROM verifikasi.transactions',
    )
    const n = counted[0]?.n
    result.transactionCount = n === undefined ? null : Number(n)

    result.ok = integrity === 'ok' && result.transactionCount !== null
    if (!result.ok && result.error === null) {
      result.error = `integrity_check: ${integrity || 'tidak menjawab'}`
    }
  } catch (e) {
    // Berkas rusak parah sering melempar di sini ("file is not a database")
    // alih-alih menjawab integrity_check. Keduanya sama artinya: jangan
    // andalkan berkas ini.
    result.error = e instanceof Error ? e.message : String(e)
  } finally {
    if (attached) {
      try {
        await prisma.$executeRawUnsafe('DETACH DATABASE verifikasi')
      } catch (e) {
        // Kalau DETACH gagal, koneksi ini menyisakan schema tertempel. Harus
        // terlihat di log: ia bisa membuat backup berikutnya gagal ATTACH.
        log.error('DETACH database verifikasi gagal', e)
      }
    }
  }

  return result
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
    verification: { ok: false, integrity: null, transactionCount: null, error: null },
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

    // Diperiksa SEBELUM disalin ke mirror: tidak ada gunanya menyebarkan berkas
    // yang ternyata tidak bisa dibuka. Hasilnya tidak membatalkan backup —
    // berkasnya tetap disimpan, statusnya saja yang tercatat gagal verifikasi.
    result.verification = await verifyBackup(target)

    result.prunedCount = pruneBackups(config.backup.keep, fileName)
    result.mirroredTo = result.verification.ok ? mirrorBackup(target) : null

    const ringkasan = {
      file: fileName,
      sizeKb: Math.round(stat.size / 1024),
      pruned: result.prunedCount,
      mirroredTo: result.mirroredTo,
      integrity: result.verification.integrity,
      transactionCount: result.verification.transactionCount,
    }

    if (result.verification.ok) {
      log.info('backup selesai dan terverifikasi', ringkasan)
    } else {
      // Bukan log.info: backup yang tidak bisa dibuka adalah keadaan yang harus
      // dilihat pemilik, bukan baris yang lewat begitu saja.
      log.error('backup TIDAK TERVERIFIKASI', {
        ...ringkasan,
        error: result.verification.error,
      })
    }

  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    log.error('backup GAGAL', e)
  }

  // Di luar try/catch dengan sengaja: backup yang GAGAL adalah justru yang paling
  // perlu tercatat. Kalau barisnya ditulis di dalam blok sukses, satu-satunya
  // kejadian yang tidak pernah terekam adalah kejadian yang penting.
  await recordBackupAudit(result)

  return result
}

/**
 * Catat hasil backup ke audit log.
 *
 * Audit log adalah buku besar sistem ini, dan "apakah backup terakhir benar-benar
 * bisa dibuka" termasuk hal yang harus bisa ditelusuri belakangan — bukan hanya
 * tampil di layar lalu hilang saat server dimatikan malam itu.
 *
 * `userId: null` karena backup startup tidak punya pelaku manusia. Backup manual
 * dari halaman pengaturan mencatat barisnya sendiri dengan pelaku yang jelas.
 */
async function recordBackupAudit(result: BackupResult): Promise<void> {
  const v = result.verification
  const status = !result.ok
    ? `GAGAL: ${result.error ?? 'tidak diketahui'}`
    : v.ok
      ? `terverifikasi, ${v.transactionCount} transaksi`
      : `TIDAK TERVERIFIKASI: ${v.error ?? v.integrity ?? 'tidak diketahui'}`

  await recordAuditSafe(
    { userId: null, role: null },
    {
      action: 'BACKUP_RUN',
      summary: `Backup ${result.file ?? '(tanpa berkas)'} — ${status}`,
      after: {
        file: result.file,
        sizeBytes: result.sizeBytes,
        verified: v.ok,
        integrity: v.integrity,
        transactionCount: v.transactionCount,
        mirroredTo: result.mirroredTo,
        prunedCount: result.prunedCount,
        error: result.error ?? v.error,
      },
    },
  )
}

/**
 * Sisakan `keep` berkas TERBARU, hapus sisanya. Mengembalikan jumlah terhapus.
 *
 * Urutannya memakai waktu modifikasi, BUKAN nama berkas. Dulu memakai nama,
 * dengan alasan "nama bercap tanggal berarti urutan leksikal == urutan waktu" —
 * dan itu salah justru pada kasus yang paling tidak boleh salah:
 *
 *   pos-20260920-021031.db     backup startup
 *   pos-20260920-021031-1.db   backup tutup shift, detik yang sama
 *
 * Secara leksikal `-1.db` datang SEBELUM `.db` (karena '-' < '.'), sehingga
 * berkas yang paling BARU dianggap paling tua dan justru dialah yang dihapus.
 * Ditemukan oleh tests/backup.test.ts saat mirror gagal menyalin berkas yang
 * baru saja dibuat: berkas itu sudah dihapus oleh prune-nya sendiri.
 *
 * `protect` adalah lapisan kedua: berkas yang baru saja dibuat tidak boleh
 * terhapus oleh pemangkasan dalam panggilan yang sama, apa pun urutannya.
 */
export function pruneBackups(keep: number, protect: string | null = null): number {
  try {
    // listBackups mengurutkan terbaru lebih dulu, jadi yang di luar `keep`
    // pertama adalah yang paling tua. Filter `protect` dipasang SETELAH slice
    // supaya jumlah yang disimpan tetap tepat `keep` pada kasus normal.
    const doomed = listBackups()
      .slice(keep)
      .filter((b) => b.file !== protect)

    let removed = 0
    for (const info of doomed) {
      try {
        fs.unlinkSync(path.join(config.paths.backups, info.file))
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
