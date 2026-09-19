import type { ReportKind } from '../enums'
import { periodRange } from '../schedule'
import { parseBusinessDate, type BusinessDate } from '../time'

/**
 * Label periode untuk manusia — modul murni.
 *
 * Tanggalnya diformat sebagai tanggal SIPIL (bukan instant), jadi zona waktu
 * mesin tidak ikut campur: `2026-09-18` selalu terbaca "Jumat, 18 September
 * 2026" di mana pun laptopnya berada.
 */

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'] as const
const BULAN = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
] as const

function civil(businessDate: BusinessDate): { d: Date; year: number; month: number; day: number } {
  const { year, month, day } = parseBusinessDate(businessDate)
  return { d: new Date(Date.UTC(year, month - 1, day)), year, month, day }
}

export function formatLongDate(businessDate: BusinessDate): string {
  const { d, year, month, day } = civil(businessDate)
  return `${HARI[d.getUTCDay()]}, ${day} ${BULAN[month - 1]} ${year}`
}

export function formatShortDate(businessDate: BusinessDate): string {
  const { month, day } = civil(businessDate)
  return `${day} ${BULAN[month - 1]}`
}

export function formatMonth(businessDate: BusinessDate): string {
  const { year, month } = civil(businessDate)
  return `${BULAN[month - 1]} ${year}`
}

/** Label periode yang menyebut rentang tanggalnya, bukan cuma kodenya. */
export function periodLabel(kind: ReportKind, periodKey: string): string {
  const { from, to } = periodRange(kind, periodKey)

  if (kind === 'DAILY') return formatLongDate(from)
  if (kind === 'MONTHLY') return formatMonth(from)

  // Kode minggu ISO tidak berarti apa-apa bagi pemilik toko, jadi selalu
  // disertai tanggalnya.
  return `Minggu ${periodKey} · ${formatShortDate(from)}–${formatLongDate(to)}`
}
