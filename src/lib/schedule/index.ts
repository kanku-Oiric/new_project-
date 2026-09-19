import type { ReportKind } from '../enums'
import { AppError } from '../errors'
import {
  addBusinessDays,
  compareBusinessDate,
  endOfIsoWeek,
  endOfMonth,
  isoWeekKey,
  monthKey,
  parseBusinessDate,
  startOfIsoWeek,
  startOfMonth,
  type BusinessDate,
} from '../time'

/**
 * Penjadwalan laporan — modul murni, tanpa DB dan tanpa `new Date()` internal.
 *
 * Referensi: docs/reporting.md §6, §7.2 dan docs/architecture.md §10
 *
 * Laptop toko dimatikan tiap malam, jadi cron PASTI melewatkan laporan.
 * Mekanisme utamanya adalah catch-up saat startup, dan seluruh perhitungan
 * "periode mana yang terlewat" ada di sini supaya bisa diuji dengan jam palsu —
 * termasuk skenario "server mati 3 hari" tanpa menunggu tiga hari.
 */

export class ScheduleError extends AppError {
  constructor(message: string) {
    super('VALIDATION', 400, message)
  }
}

export const DEFAULT_BACKLOG_CAP = 60

const DAILY_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEKLY_RE = /^\d{4}-W\d{2}$/
const MONTHLY_RE = /^\d{4}-\d{2}$/

export function isValidPeriodKey(kind: ReportKind, periodKey: string): boolean {
  if (kind === 'DAILY') return DAILY_RE.test(periodKey)
  if (kind === 'WEEKLY') return WEEKLY_RE.test(periodKey)
  return MONTHLY_RE.test(periodKey)
}

export function assertPeriodKey(kind: ReportKind, periodKey: string): void {
  if (!isValidPeriodKey(kind, periodKey)) {
    throw new ScheduleError(`periodKey "${periodKey}" tidak sah untuk laporan ${kind}`)
  }
}

/** periodKey yang memuat sebuah businessDate. */
export function periodKeyFor(kind: ReportKind, businessDate: BusinessDate): string {
  switch (kind) {
    case 'DAILY':
      parseBusinessDate(businessDate)
      return businessDate
    case 'WEEKLY':
      return isoWeekKey(businessDate)
    case 'MONTHLY':
      return monthKey(businessDate)
  }
}

export interface PeriodRange {
  from: BusinessDate
  to: BusinessDate
}

/**
 * Rentang businessDate sebuah periode, inklusif di kedua ujung.
 *
 * Untuk WEEKLY, kuncinya diterjemahkan lewat hari Kamis di minggu itu: ISO week
 * 1 adalah minggu yang memuat Kamis pertama Januari, jadi Kamis selalu jatuh di
 * tahun kalender yang sama dengan ISO week-year-nya. Menghitung dari 1 Januari
 * akan meleset di pergantian tahun (docs/reporting.md §6.1).
 */
export function periodRange(kind: ReportKind, periodKey: string): PeriodRange {
  assertPeriodKey(kind, periodKey)

  if (kind === 'DAILY') {
    return { from: periodKey, to: periodKey }
  }

  if (kind === 'MONTHLY') {
    const first = `${periodKey}-01`
    return { from: startOfMonth(first), to: endOfMonth(first) }
  }

  const isoYear = Number(periodKey.slice(0, 4))
  const isoWeek = Number(periodKey.slice(6))
  if (isoWeek < 1 || isoWeek > 53) {
    throw new ScheduleError(`Nomor minggu ISO tidak sah: ${periodKey}`)
  }

  // 4 Januari selalu berada di ISO week 1, menurut definisi.
  const jan4 = `${isoYear}-01-04`
  const week1Monday = startOfIsoWeek(jan4)
  const monday = addBusinessDays(week1Monday, (isoWeek - 1) * 7)

  // Minggu ke-53 tidak ada di setiap tahun. Kalau hasilnya melompat ke ISO
  // week-year berikutnya, kuncinya memang tidak pernah ada.
  if (isoWeekKey(monday) !== periodKey) {
    throw new ScheduleError(`Minggu ${periodKey} tidak ada dalam kalender ISO`)
  }

  return { from: monday, to: endOfIsoWeek(monday) }
}

/** periodKey berikutnya setelah `periodKey`. */
export function nextPeriodKey(kind: ReportKind, periodKey: string): string {
  const { to } = periodRange(kind, periodKey)
  return periodKeyFor(kind, addBusinessDays(to, 1))
}

export function previousPeriodKey(kind: ReportKind, periodKey: string): string {
  const { from } = periodRange(kind, periodKey)
  return periodKeyFor(kind, addBusinessDays(from, -1))
}

/**
 * Sebuah periode "selesai" hanya setelah hari terakhirnya berlalu.
 *
 * Konsekuensi yang disengaja: laporan hari ini TIDAK PERNAH dikirim otomatis.
 * Mengirim periode yang belum berakhir berarti angka yang dikirim bukan angka
 * final, dan laporan yang harus dibaca dua kali tidak lebih baik daripada
 * laporan yang datang besok pagi. Tombol "Kirim laporan sekarang" tetap bisa
 * mengirimnya secara manual (docs/reporting.md §6.3).
 */
export function isPeriodComplete(
  kind: ReportKind,
  periodKey: string,
  today: BusinessDate,
): boolean {
  const { to } = periodRange(kind, periodKey)
  return compareBusinessDate(to, today) < 0
}

export interface MissingPeriodsInput {
  kind: ReportKind
  /**
   * periodKey terakhir yang BERHASIL dikirim otomatis. `null` berarti belum
   * pernah — instalasi baru.
   */
  lastSentKey: string | null
  /** Dipakai saat `lastSentKey` null: periode paling awal yang layak dikirim. */
  earliestKey: string | null
  /** businessDate hari ini di WIB. */
  today: BusinessDate
  cap?: number
}

/**
 * Daftar periode yang terlewat, urut dari paling lama ke paling baru.
 *
 * Cap membatasi backlog: laptop yang mati enam bulan tidak boleh mengirim 180
 * pesan bertubi-tubi ke Discord. Yang dipotong adalah periode TERLAMA, karena
 * kalau harus memilih, laporan minggu lalu lebih berguna daripada laporan lima
 * bulan lalu.
 */
export function missingPeriods(input: MissingPeriodsInput): string[] {
  const cap = input.cap ?? DEFAULT_BACKLOG_CAP
  if (!Number.isInteger(cap) || cap < 1) {
    throw new ScheduleError(`cap harus integer >= 1, dapat ${cap}`)
  }

  const todayKey = periodKeyFor(input.kind, input.today)

  let cursor: string
  if (input.lastSentKey) {
    assertPeriodKey(input.kind, input.lastSentKey)
    cursor = nextPeriodKey(input.kind, input.lastSentKey)
  } else if (input.earliestKey) {
    assertPeriodKey(input.kind, input.earliestKey)
    cursor = input.earliestKey
  } else {
    // Belum pernah kirim dan belum ada transaksi sama sekali: tidak ada yang
    // bisa dilaporkan. Instalasi baru tidak dibanjiri laporan kosong.
    return []
  }

  const out: string[] = []
  // Batas keras jumlah iterasi supaya kunci yang aneh tidak pernah bisa
  // menghasilkan loop tak berujung di dalam proses server toko.
  const maxIterations = cap * 20 + 1000

  for (let i = 0; i < maxIterations; i++) {
    if (cursor === todayKey) break
    if (!isPeriodComplete(input.kind, cursor, input.today)) break
    out.push(cursor)
    cursor = nextPeriodKey(input.kind, cursor)
  }

  return out.length > cap ? out.slice(out.length - cap) : out
}

// ─────────────────────────────── Pemicu berkala ───────────────────────────────

export interface CatchUpTickInput {
  now: Date
  /** businessDate saat catch-up terakhir dijalankan. null kalau belum pernah. */
  lastRunBusinessDate: BusinessDate | null
  lastRunAt: Date | null
  today: BusinessDate
  /** Jeda minimum antar-pemeriksaan rutin. */
  minIntervalMs?: number
}

export const DEFAULT_CATCHUP_INTERVAL_MS = 10 * 60_000

/**
 * Apakah scheduler perlu menjalankan catch-up pada tick ini.
 *
 * Scheduler berdetak tiap menit, tapi catch-up TIDAK dijalankan tiap menit:
 * database yang sama sedang dipakai kasir, dan enam query tiap menit hanya
 * untuk mendapati "tidak ada yang perlu dikirim" adalah gangguan tanpa manfaat.
 *
 * Dijalankan kalau hari usaha berganti (ada periode baru yang mungkin selesai)
 * atau kalau sudah cukup lama sejak pemeriksaan terakhir (untuk memungut
 * pengiriman yang gagal dan bisa dicoba lagi).
 */
export function shouldRunCatchUp(input: CatchUpTickInput): boolean {
  if (input.lastRunAt === null || input.lastRunBusinessDate === null) return true
  if (input.lastRunBusinessDate !== input.today) return true

  const interval = input.minIntervalMs ?? DEFAULT_CATCHUP_INTERVAL_MS
  return input.now.getTime() - input.lastRunAt.getTime() >= interval
}
