import 'server-only'
import { runBackup } from './backup'
import { config } from './config'
import { applyPragmas } from './db/prisma'
import { checkDatabase, pruneExpiredSessions } from './db/maintenance'
import { createLogger, pruneLogs } from './logger'
import { enqueue } from './notify/queue'
import { catchUpReportsSafe } from './report/service'
import { startReportScheduler } from './report/scheduler'

/**
 * ATURAN IMPOR FILE INI: apa pun yang diimpor di sini ikut ditelusuri webpack
 * saat `instrumentation.ts` dikompilasi untuk runtime non-Node. Jangan pernah
 * mengimpor modul dari `auth/` (bcryptjs, node:crypto) atau dependensi lain
 * yang tidak bisa di-resolve di luar Node — lihat src/lib/db/maintenance.ts.
 *
 * Rantai laporan di bawah aman menurut aturan itu: report/ → notify/ hanya
 * memakai `fetch` dan Prisma, tidak ada kriptografi di jalurnya.
 */

const log = createLogger('startup')

/** Jeda sebelum catch-up, supaya boot server tidak berebut dengan jaringan. */
const CATCHUP_START_DELAY_MS = 3_000

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

  // 4. Catch-up laporan — mekanisme utama penjadwalan, bukan cadangan.
  //
  //    NON-BLOCKING dengan sengaja: pengiriman melibatkan jaringan, dan kasir
  //    tidak boleh menunggu Discord untuk bisa membuka layar kasir. Kegagalannya
  //    sudah ditelan di dalam catchUpReportsSafe.
  //
  //    Jeda singkat memberi server kesempatan selesai boot lebih dulu; timer-nya
  //    di-unref supaya tidak pernah menahan proses tetap hidup.
  try {
    const delay = setTimeout(() => {
      void enqueue(() => catchUpReportsSafe(new Date()))
    }, CATCHUP_START_DELAY_MS)
    delay.unref?.()

    startReportScheduler()
  } catch (e) {
    log.error('gagal menjadwalkan catch-up laporan — sisanya tetap jalan', e)
  }

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

// `checkDatabase` dipindah ke src/lib/db/maintenance.ts supaya /api/health tidak
// perlu mengimpor seluruh modul startup (backup, logger, node:fs) hanya untuk
// menjalankan satu SELECT 1. Di-reexport di sini agar pemanggil lama tetap jalan.
export { checkDatabase }
