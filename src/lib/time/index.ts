/**
 * Waktu & hari usaha.
 *
 * Aturan yang ditegakkan file ini (docs/architecture.md §5):
 *  - Semua timestamp disimpan UTC.
 *  - Pengelompokan laporan memakai `businessDate` "YYYY-MM-DD" dalam zona toko
 *    (default Asia/Jakarta / WIB, UTC+7 tanpa DST).
 *  - TIDAK ADA `new Date()` di dalam modul ini. Instant selalu di-inject sebagai
 *    parameter, karena itulah satu-satunya cara test "server mati 3 hari" bisa
 *    ditulis.
 */

export const DEFAULT_TIMEZONE = 'Asia/Jakarta'

export class TimeError extends Error {}

/** "YYYY-MM-DD" dalam zona toko. */
export type BusinessDate = string

interface CivilParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz)
  if (cached) return cached
  // hourCycle h23 supaya tengah malam menjadi 00, bukan 24 — beberapa locale
  // melaporkan jam 24 dan itu menghancurkan aritmatika offset di bawah.
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  formatterCache.set(tz, f)
  return f
}

/** Pecah sebuah instant menjadi komponen kalender di zona tertentu. */
function civilPartsIn(instant: Date, tz: string): CivilParts {
  if (!Number.isFinite(instant.getTime())) {
    throw new TimeError('instant tidak valid')
  }
  const parts = formatterFor(tz).formatToParts(instant)
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    if (!found) throw new TimeError(`komponen "${type}" tidak tersedia untuk zona ${tz}`)
    return Number(found.value)
  }
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Instant → businessDate di zona toko.
 *
 * Dibangun dari formatToParts dan disusun manual, bukan dari string locale,
 * supaya hasilnya tidak bergantung pada locale sistem laptop toko.
 */
export function toBusinessDate(instant: Date, tz: string = DEFAULT_TIMEZONE): BusinessDate {
  const { year, month, day } = civilPartsIn(instant, tz)
  return `${year}-${pad2(month)}-${pad2(day)}`
}

const BUSINESS_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Pecah "YYYY-MM-DD" menjadi angka, sekaligus menolak tanggal yang tidak ada. */
export function parseBusinessDate(businessDate: BusinessDate): {
  year: number
  month: number
  day: number
} {
  const m = BUSINESS_DATE_RE.exec(businessDate)
  if (!m) throw new TimeError(`businessDate harus "YYYY-MM-DD", dapat "${businessDate}"`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])

  // Date.UTC menormalkan tanggal mustahil (31 Feb → 3 Mar), jadi cek balik.
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new TimeError(`tanggal tidak ada: "${businessDate}"`)
  }
  return { year, month, day }
}

/** businessDate sebagai instant UTC tengah malam — dasar aritmatika hari. */
function businessDateToCivilUtc(businessDate: BusinessDate): Date {
  const { year, month, day } = parseBusinessDate(businessDate)
  return new Date(Date.UTC(year, month - 1, day))
}

function civilUtcToBusinessDate(d: Date): BusinessDate {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** Geser businessDate sejumlah hari. Aman melewati batas bulan dan tahun. */
export function addBusinessDays(businessDate: BusinessDate, days: number): BusinessDate {
  if (!Number.isInteger(days)) throw new TimeError(`days harus integer, dapat ${days}`)
  const d = businessDateToCivilUtc(businessDate)
  d.setUTCDate(d.getUTCDate() + days)
  return civilUtcToBusinessDate(d)
}

/** −1 kalau a lebih awal, 0 kalau sama, 1 kalau a lebih akhir. */
export function compareBusinessDate(a: BusinessDate, b: BusinessDate): number {
  parseBusinessDate(a)
  parseBusinessDate(b)
  // Format YYYY-MM-DD zero-padded, jadi urutan leksikal == urutan kronologis.
  return a < b ? -1 : a > b ? 1 : 0
}

/** Selisih hari b − a. */
export function diffBusinessDays(a: BusinessDate, b: BusinessDate): number {
  const ms = businessDateToCivilUtc(b).getTime() - businessDateToCivilUtc(a).getTime()
  return Math.round(ms / 86_400_000)
}

/**
 * Daftar businessDate dari `from` sampai `to` inklusif.
 * `limit` mencegah backlog raksasa menghasilkan array tak terbatas.
 */
export function enumerateBusinessDates(
  from: BusinessDate,
  to: BusinessDate,
  limit = 400,
): BusinessDate[] {
  if (compareBusinessDate(from, to) > 0) return []
  const out: BusinessDate[] = []
  let cursor = from
  while (compareBusinessDate(cursor, to) <= 0) {
    out.push(cursor)
    if (out.length >= limit) break
    cursor = addBusinessDays(cursor, 1)
  }
  return out
}

// ─────────────────────────── ISO week & bulan ───────────────────────────

/**
 * ISO-8601 week: Senin–Minggu, dan minggu 1 adalah minggu yang memuat Kamis
 * pertama Januari.
 *
 * ISO week-year TIDAK selalu sama dengan tahun kalender. Contoh nyata:
 * 2025-12-29 (Senin) ada di 2026-W01, bukan 2025-W53. Memakai getFullYear()
 * untuk menyusun kunci mingguan akan menghasilkan kunci salah, yang membuat
 * catch-up mengirim ganda atau melewatkan satu minggu.
 */
export function isoWeekOf(businessDate: BusinessDate): { isoYear: number; isoWeek: number } {
  const target = businessDateToCivilUtc(businessDate)

  // Geser ke hari Kamis di minggu ISO yang sama; tahun dari Kamis itulah
  // ISO week-year-nya, menurut definisi.
  const dayNum = target.getUTCDay() === 0 ? 7 : target.getUTCDay() // Sen=1..Min=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum)

  const isoYear = target.getUTCFullYear()
  const yearStart = Date.UTC(isoYear, 0, 1)
  const days = Math.round((target.getTime() - yearStart) / 86_400_000)
  const isoWeek = Math.floor(days / 7) + 1

  return { isoYear, isoWeek }
}

/** "2026-W38" */
export function isoWeekKey(businessDate: BusinessDate): string {
  const { isoYear, isoWeek } = isoWeekOf(businessDate)
  return `${isoYear}-W${pad2(isoWeek)}`
}

/** businessDate hari Senin pada minggu ISO yang memuat tanggal ini. */
export function startOfIsoWeek(businessDate: BusinessDate): BusinessDate {
  const d = businessDateToCivilUtc(businessDate)
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  return addBusinessDays(businessDate, 1 - dayNum)
}

/** businessDate hari Minggu pada minggu ISO yang memuat tanggal ini. */
export function endOfIsoWeek(businessDate: BusinessDate): BusinessDate {
  return addBusinessDays(startOfIsoWeek(businessDate), 6)
}

/** "2026-09" */
export function monthKey(businessDate: BusinessDate): string {
  const { year, month } = parseBusinessDate(businessDate)
  return `${year}-${pad2(month)}`
}

export function startOfMonth(businessDate: BusinessDate): BusinessDate {
  const { year, month } = parseBusinessDate(businessDate)
  return `${year}-${pad2(month)}-01`
}

export function endOfMonth(businessDate: BusinessDate): BusinessDate {
  const { year, month } = parseBusinessDate(businessDate)
  // Hari 0 bulan berikutnya = hari terakhir bulan ini.
  const last = new Date(Date.UTC(year, month, 0))
  return civilUtcToBusinessDate(last)
}

// ─────────────────────────── Konversi civil ↔ UTC ───────────────────────────

/** Offset zona (menit) pada sebuah instant. Positif = di depan UTC. */
function tzOffsetMinutes(instant: Date, tz: string): number {
  const p = civilPartsIn(instant, tz)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asIfUtc - instant.getTime()) / 60_000)
}

/**
 * Waktu lokal di zona toko → instant UTC.
 *
 * Dua langkah: tebak dengan offset pada tebakan pertama, lalu perbaiki kalau
 * offset di instant hasil berbeda. WIB tidak punya DST sehingga langkah kedua
 * tidak pernah terpakai, tapi fungsi ini tetap benar untuk zona yang punya.
 */
export function civilToUtc(
  businessDate: BusinessDate,
  hour: number,
  minute: number,
  tz: string = DEFAULT_TIMEZONE,
): Date {
  const { year, month, day } = parseBusinessDate(businessDate)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new TimeError(`jam tidak valid: ${hour}:${minute}`)
  }
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0)

  const off1 = tzOffsetMinutes(new Date(wanted), tz)
  let ts = wanted - off1 * 60_000
  const off2 = tzOffsetMinutes(new Date(ts), tz)
  if (off2 !== off1) ts = wanted - off2 * 60_000

  return new Date(ts)
}

/**
 * Rentang UTC untuk satu hari usaha, untuk query yang menyaring `createdAt`.
 * `endUtcExclusive` eksklusif — pakai `lt`, bukan `lte`, supaya transaksi tepat
 * tengah malam tidak terhitung di dua hari.
 */
export function businessDayRangeUtc(
  businessDate: BusinessDate,
  tz: string = DEFAULT_TIMEZONE,
): { startUtc: Date; endUtcExclusive: Date } {
  return {
    startUtc: civilToUtc(businessDate, 0, 0, tz),
    endUtcExclusive: civilToUtc(addBusinessDays(businessDate, 1), 0, 0, tz),
  }
}

/** Jam:menit di zona toko, untuk tampilan ringkasan shift. */
export function formatClock(instant: Date, tz: string = DEFAULT_TIMEZONE): string {
  const { hour, minute } = civilPartsIn(instant, tz)
  return `${pad2(hour)}:${pad2(minute)}`
}
