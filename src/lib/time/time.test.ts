import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEZONE,
  TimeError,
  addBusinessDays,
  businessDayRangeUtc,
  civilToUtc,
  compareBusinessDate,
  diffBusinessDays,
  endOfIsoWeek,
  endOfMonth,
  enumerateBusinessDates,
  formatClock,
  isoWeekKey,
  isoWeekOf,
  monthKey,
  parseBusinessDate,
  startOfIsoWeek,
  startOfMonth,
  toBusinessDate,
} from './index'

describe('toBusinessDate', () => {
  it('memakai zona toko, bukan zona sistem', () => {
    // 2026-09-18 03:00 UTC = 10:00 WIB, hari yang sama.
    expect(toBusinessDate(new Date('2026-09-18T03:00:00Z'))).toBe('2026-09-18')
  })

  it('benar di sekitar tengah malam WIB', () => {
    // WIB = UTC+7. Tengah malam WIB tanggal 19 = 17:00 UTC tanggal 18.
    expect(toBusinessDate(new Date('2026-09-18T16:59:59Z'))).toBe('2026-09-18') // 23:59:59 WIB
    expect(toBusinessDate(new Date('2026-09-18T17:00:00Z'))).toBe('2026-09-19') // 00:00:00 WIB
    expect(toBusinessDate(new Date('2026-09-18T17:00:01Z'))).toBe('2026-09-19') // 00:00:01 WIB
  })

  it('transaksi jam 22:00 WIB masuk hari itu, bukan hari berikutnya', () => {
    // Ini kasus nyata: toko tutup jam 22, dan naif memakai UTC akan
    // memindahkan penjualan malam ke tanggal berikutnya.
    const jam22Wib = new Date('2026-09-18T15:00:00Z')
    expect(toBusinessDate(jam22Wib)).toBe('2026-09-18')
    // Bandingkan: tanggal UTC-nya juga 18, tapi jam 01:00 WIB tanggal 19...
    const jam01Wib = new Date('2026-09-18T18:00:00Z')
    expect(jam01Wib.toISOString().slice(0, 10)).toBe('2026-09-18') // UTC bilang 18
    expect(toBusinessDate(jam01Wib)).toBe('2026-09-19') // WIB bilang 19 — ini yang benar
  })

  it('benar di batas bulan dan tahun', () => {
    expect(toBusinessDate(new Date('2026-08-31T17:00:00Z'))).toBe('2026-09-01')
    expect(toBusinessDate(new Date('2026-12-31T16:59:59Z'))).toBe('2026-12-31')
    expect(toBusinessDate(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01')
  })

  it('mendukung zona lain kalau setting diubah', () => {
    const instant = new Date('2026-09-18T17:00:00Z')
    expect(toBusinessDate(instant, 'Asia/Jakarta')).toBe('2026-09-19')
    expect(toBusinessDate(instant, 'UTC')).toBe('2026-09-18')
    expect(toBusinessDate(instant, 'Asia/Jayapura')).toBe('2026-09-19') // WIT = UTC+9
  })
})

describe('parseBusinessDate', () => {
  it('menerima format yang benar', () => {
    expect(parseBusinessDate('2026-09-18')).toEqual({ year: 2026, month: 9, day: 18 })
  })

  it('menolak format salah', () => {
    expect(() => parseBusinessDate('2026-9-18')).toThrow(TimeError)
    expect(() => parseBusinessDate('18-09-2026')).toThrow(TimeError)
    expect(() => parseBusinessDate('')).toThrow(TimeError)
  })

  it('menolak tanggal yang tidak ada, bukan menormalkannya diam-diam', () => {
    expect(() => parseBusinessDate('2026-02-31')).toThrow(TimeError)
    expect(() => parseBusinessDate('2026-13-01')).toThrow(TimeError)
    expect(() => parseBusinessDate('2026-02-29')).toThrow(TimeError) // 2026 bukan kabisat
    expect(parseBusinessDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 }) // kabisat
  })
})

describe('addBusinessDays', () => {
  it('menggeser hari biasa', () => {
    expect(addBusinessDays('2026-09-18', 1)).toBe('2026-09-19')
    expect(addBusinessDays('2026-09-18', -1)).toBe('2026-09-17')
    expect(addBusinessDays('2026-09-18', 0)).toBe('2026-09-18')
  })

  it('melewati batas bulan, tahun, dan kabisat', () => {
    expect(addBusinessDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addBusinessDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addBusinessDays('2026-02-28', 1)).toBe('2026-03-01') // bukan kabisat
    expect(addBusinessDays('2028-02-28', 1)).toBe('2028-02-29') // kabisat
    expect(addBusinessDays('2026-01-31', 1)).toBe('2026-02-01')
  })
})

describe('compareBusinessDate & diffBusinessDays', () => {
  it('mengurutkan secara kronologis', () => {
    expect(compareBusinessDate('2026-09-17', '2026-09-18')).toBe(-1)
    expect(compareBusinessDate('2026-09-18', '2026-09-18')).toBe(0)
    expect(compareBusinessDate('2026-10-01', '2026-09-30')).toBe(1)
    expect(compareBusinessDate('2027-01-01', '2026-12-31')).toBe(1)
  })

  it('menghitung selisih hari', () => {
    expect(diffBusinessDays('2026-09-15', '2026-09-18')).toBe(3)
    expect(diffBusinessDays('2026-09-18', '2026-09-15')).toBe(-3)
    expect(diffBusinessDays('2026-12-31', '2027-01-01')).toBe(1)
    expect(diffBusinessDays('2026-01-01', '2027-01-01')).toBe(365)
  })
})

describe('enumerateBusinessDates', () => {
  it('skenario "server mati 3 hari"', () => {
    // Delivery terakhir 2026-09-14, hari ini 2026-09-18 → yang terlewat
    // adalah 15, 16, 17 (hari ini belum selesai, tidak ikut).
    expect(enumerateBusinessDates('2026-09-15', '2026-09-17')).toEqual([
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
    ])
  })

  it('satu hari kalau from == to', () => {
    expect(enumerateBusinessDates('2026-09-18', '2026-09-18')).toEqual(['2026-09-18'])
  })

  it('kosong kalau from > to — tidak pernah mengirim laporan masa depan', () => {
    expect(enumerateBusinessDates('2026-09-19', '2026-09-18')).toEqual([])
  })

  it('menghormati limit supaya laptop mati 6 bulan tidak spam', () => {
    const out = enumerateBusinessDates('2026-01-01', '2026-12-31', 60)
    expect(out).toHaveLength(60)
    expect(out[0]).toBe('2026-01-01')
    expect(out[59]).toBe('2026-03-01')
  })
})

describe('isoWeekOf / isoWeekKey', () => {
  it('menghitung minggu ISO biasa', () => {
    // 2026-09-18 adalah Jumat di minggu ke-38 (minggu mulai Senin 2026-09-14).
    expect(isoWeekOf('2026-09-18')).toEqual({ isoYear: 2026, isoWeek: 38 })
    expect(isoWeekKey('2026-09-18')).toBe('2026-W38')
    expect(isoWeekKey('2026-09-14')).toBe('2026-W38')
    expect(isoWeekKey('2026-09-20')).toBe('2026-W38')
    expect(isoWeekKey('2026-09-21')).toBe('2026-W39')
  })

  it('ISO week-year berbeda dari tahun kalender di batas tahun', () => {
    // Jebakan utama. 2026-01-01 jatuh hari Kamis, jadi minggu 1 tahun 2026
    // dimulai Senin 2025-12-29 — dan tanggal itu berkunci 2026-W01.
    expect(isoWeekKey('2025-12-29')).toBe('2026-W01')
    expect(isoWeekKey('2025-12-31')).toBe('2026-W01')
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01')
    expect(isoWeekKey('2026-01-04')).toBe('2026-W01')
    expect(isoWeekKey('2026-01-05')).toBe('2026-W02')

    // Arah sebaliknya: awal Januari yang masih milik tahun sebelumnya.
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53')
    expect(isoWeekKey('2027-01-03')).toBe('2026-W53')
    expect(isoWeekKey('2027-01-04')).toBe('2027-W01')
  })

  it('kunci selalu zero-padded dua digit', () => {
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01')
    expect(isoWeekKey('2026-03-05')).toBe('2026-W10')
  })

  it('tahun dengan 53 minggu', () => {
    expect(isoWeekOf('2026-12-31').isoWeek).toBe(53)
  })
})

describe('startOfIsoWeek / endOfIsoWeek', () => {
  it('Senin sampai Minggu', () => {
    expect(startOfIsoWeek('2026-09-18')).toBe('2026-09-14') // Jumat → Senin
    expect(endOfIsoWeek('2026-09-18')).toBe('2026-09-20') // Jumat → Minggu
    expect(startOfIsoWeek('2026-09-14')).toBe('2026-09-14') // Senin → dirinya
    expect(startOfIsoWeek('2026-09-20')).toBe('2026-09-14') // Minggu → Senin sebelumnya
  })

  it('minggu yang menyeberang tahun', () => {
    expect(startOfIsoWeek('2026-01-01')).toBe('2025-12-29')
    expect(endOfIsoWeek('2025-12-29')).toBe('2026-01-04')
  })
})

describe('monthKey / startOfMonth / endOfMonth', () => {
  it('kunci bulan', () => {
    expect(monthKey('2026-09-18')).toBe('2026-09')
    expect(monthKey('2026-01-01')).toBe('2026-01')
  })

  it('awal dan akhir bulan, termasuk Februari', () => {
    expect(startOfMonth('2026-09-18')).toBe('2026-09-01')
    expect(endOfMonth('2026-09-18')).toBe('2026-09-30')
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28')
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29') // kabisat
    expect(endOfMonth('2026-12-01')).toBe('2026-12-31')
  })
})

describe('civilToUtc & businessDayRangeUtc', () => {
  it('tengah malam WIB = 17:00 UTC hari sebelumnya', () => {
    expect(civilToUtc('2026-09-18', 0, 0).toISOString()).toBe('2026-09-17T17:00:00.000Z')
  })

  it('jam kerja WIB dikonversi benar', () => {
    expect(civilToUtc('2026-09-18', 7, 0).toISOString()).toBe('2026-09-18T00:00:00.000Z')
    expect(civilToUtc('2026-09-18', 21, 30).toISOString()).toBe('2026-09-18T14:30:00.000Z')
  })

  it('rentang hari usaha tepat 24 jam dan eksklusif di ujung', () => {
    const { startUtc, endUtcExclusive } = businessDayRangeUtc('2026-09-18')
    expect(startUtc.toISOString()).toBe('2026-09-17T17:00:00.000Z')
    expect(endUtcExclusive.toISOString()).toBe('2026-09-18T17:00:00.000Z')
    expect(endUtcExclusive.getTime() - startUtc.getTime()).toBe(86_400_000)
  })

  it('rentang konsisten dengan toBusinessDate di kedua ujungnya', () => {
    // Invariant #20 di docs/database.md: businessDate sebuah baris == tanggal
    // WIB dari createdAt-nya. Kedua fungsi harus sepakat.
    const bd = '2026-09-18'
    const { startUtc, endUtcExclusive } = businessDayRangeUtc(bd)
    expect(toBusinessDate(startUtc)).toBe(bd)
    expect(toBusinessDate(new Date(endUtcExclusive.getTime() - 1))).toBe(bd)
    expect(toBusinessDate(endUtcExclusive)).toBe(addBusinessDays(bd, 1))
  })

  it('menolak jam di luar rentang', () => {
    expect(() => civilToUtc('2026-09-18', 24, 0)).toThrow(TimeError)
    expect(() => civilToUtc('2026-09-18', -1, 0)).toThrow(TimeError)
    expect(() => civilToUtc('2026-09-18', 0, 60)).toThrow(TimeError)
  })

  it('benar untuk zona yang punya DST (bukan WIB, tapi jalurnya diuji)', () => {
    // 2026-03-29 adalah hari DST maju di Eropa. Tengah malam tetap ada.
    const d = civilToUtc('2026-03-29', 0, 0, 'Europe/Amsterdam')
    expect(toBusinessDate(d, 'Europe/Amsterdam')).toBe('2026-03-29')
  })
})

describe('formatClock', () => {
  it('menampilkan jam di zona toko', () => {
    expect(formatClock(new Date('2026-09-18T00:00:00Z'))).toBe('07:00')
    expect(formatClock(new Date('2026-09-18T14:30:00Z'))).toBe('21:30')
    expect(formatClock(new Date('2026-09-18T17:00:00Z'))).toBe('00:00')
  })
})

describe('DEFAULT_TIMEZONE', () => {
  it('adalah Asia/Jakarta', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Jakarta')
  })
})
