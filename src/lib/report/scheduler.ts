import { config } from '../config'
import { createLogger } from '../logger'
import { enqueue } from '../notify/queue'
import { shouldRunCatchUp } from '../schedule'
import { toBusinessDate, type BusinessDate } from '../time'
import { catchUpReportsSafe } from './service'

const log = createLogger('scheduler')

/**
 * Pemicu berkala — OPTIMISASI, bukan mekanisme utama.
 *
 * Referensi: docs/architecture.md §10.3
 *
 * Yang menjamin laporan terkirim adalah catch-up saat startup. Scheduler ini
 * hanya menutup kasus "laptop menyala terus dari kemarin sampai lewat tengah
 * malam", dan ia memanggil `catchUpReports` yang sama persis — tidak ada logika
 * penjadwalan kedua yang bisa menyimpang dari yang pertama.
 *
 * Kenapa `cron` tidak dipakai: satu-satunya proses yang pasti hidup adalah
 * server Next.js itu sendiri, dan menambah dependensi penjadwal tidak
 * menyelesaikan masalah sebenarnya — laptopnya mati tiap malam.
 */

const TICK_MS = 60_000

interface SchedulerState {
  timer?: ReturnType<typeof setInterval>
  lastRunAt: Date | null
  lastRunBusinessDate: BusinessDate | null
}

const globalForScheduler = globalThis as unknown as { reportScheduler?: SchedulerState }

function state(): SchedulerState {
  globalForScheduler.reportScheduler ??= { lastRunAt: null, lastRunBusinessDate: null }
  return globalForScheduler.reportScheduler
}

async function tick(now: Date = new Date()): Promise<void> {
  const s = state()
  const today = toBusinessDate(now, config.timezone)

  if (
    !shouldRunCatchUp({
      now,
      today,
      lastRunAt: s.lastRunAt,
      lastRunBusinessDate: s.lastRunBusinessDate,
    })
  ) {
    return
  }

  s.lastRunAt = now
  s.lastRunBusinessDate = today

  // Lewat antrean: kalau pemilik menekan "Kirim laporan sekarang" pada detik
  // yang sama, keduanya tidak saling mendahului ke webhook yang sama.
  await enqueue(() => catchUpReportsSafe(now))
}

/**
 * Mulai pemicu berkala. Aman dipanggil berkali-kali — `next dev` memuat ulang
 * modul saat HMR, dan tanpa penjaga ini setiap perubahan file akan menambah
 * satu interval baru yang tidak pernah dihentikan.
 */
export function startReportScheduler(): void {
  const s = state()
  if (s.timer) return

  const timer = setInterval(() => {
    void tick().catch((e) => log.error('tick scheduler gagal', e))
  }, TICK_MS)

  // Jangan menahan proses tetap hidup hanya demi timer ini.
  timer.unref?.()
  s.timer = timer

  log.info('scheduler laporan aktif', { tickMs: TICK_MS })
}

export function stopReportScheduler(): void {
  const s = state()
  if (s.timer) {
    clearInterval(s.timer)
    s.timer = undefined
  }
}

/** Dipakai test: jalankan satu tick secara langsung dengan jam yang ditentukan. */
export async function runSchedulerTick(now: Date): Promise<void> {
  await tick(now)
}
