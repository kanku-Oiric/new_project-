import 'server-only'
import { runBackup } from './backup'
import { config } from './config'
import { applyPragmas, prisma } from './db/prisma'
import { pruneExpiredSessions } from './auth/session'
import { createLogger, pruneLogs } from './logger'

const log = createLogger('startup')

/**
 * Tugas yang dijalankan sekali saat server menyala.
 *
 * ATURAN MUTLAK: fungsi ini tidak boleh membuat server gagal boot. Toko harus
 * tetap bisa jualan walaupun backup gagal, log tidak bisa ditulis, dan Discord
 * mati. Karena itu setiap langkah dibungkus try/catch sendiri — satu gagal,
 * yang lain tetap jalan.
 */

const globalForStartup = globalThis as unknown as { startupDone?: boolean }

export interface StartupReport {
  pragmaOk: boolean
  backupFile: string | null
  backupError: string | null
  sessionsPruned: number
  logsPruned: number
}

export async function runStartupTasks(now: Date = new Date()): Promise<StartupReport> {
  const report: StartupReport = {
    pragmaOk: false,
    backupFile: null,
    backupError: null,
    sessionsPruned: 0,
    logsPruned: 0,
  }

  // 1. PRAGMA — harus lebih dulu dari query apa pun.
  try {
    await applyPragmas()
    report.pragmaOk = true
  } catch (e) {
    log.error('gagal menerapkan PRAGMA', e)
  }

  // 2. Backup. Dijalankan setiap kali server menyala, karena laptop toko
  //    dimatikan tiap malam — jadi ini otomatis berarti backup harian.
  try {
    const result = await runBackup(now)
    report.backupFile = result.file
    report.backupError = result.error
  } catch (e) {
    // runBackup sendiri sudah tidak melempar, tapi jaring ini tetap dipasang
    // supaya perubahan di masa depan tidak diam-diam menjatuhkan boot.
    report.backupError = e instanceof Error ? e.message : String(e)
    log.error('backup melempar di luar dugaan', e)
  }

  // 3. Bersih-bersih ringan.
  try {
    report.sessionsPruned = await pruneExpiredSessions(now)
  } catch (e) {
    log.warn('prune session gagal', { error: e instanceof Error ? e.message : String(e) })
  }

  try {
    report.logsPruned = pruneLogs(now)
  } catch (e) {
    log.warn('prune log gagal', { error: e instanceof Error ? e.message : String(e) })
  }

  // 4. Catch-up laporan menyusul di Fase 6. Titik pemanggilannya di sini,
  //    non-blocking, setelah semua di atas selesai.

  log.info('startup selesai', {
    ...report,
    timezone: config.timezone,
  })

  return report
}

/**
 * Jaga agar hanya jalan sekali per proses. `next dev` memuat ulang modul saat
 * HMR, dan tanpa penjaga ini setiap perubahan file akan memicu backup baru.
 */
export async function runStartupTasksOnce(): Promise<void> {
  if (globalForStartup.startupDone) return
  globalForStartup.startupDone = true

  try {
    await runStartupTasks()
  } catch (e) {
    log.error('runStartupTasks gagal total — server tetap dilanjutkan', e)
  }
}

/** Cek kesehatan untuk /api/health dan dashboard. */
export async function checkDatabase(): Promise<{ ok: boolean; error: string | null }> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    return { ok: true, error: null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
