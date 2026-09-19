import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BACKLOG_CAP,
  ScheduleError,
  isPeriodComplete,
  missingPeriods,
  nextPeriodKey,
  periodKeyFor,
  periodRange,
  previousPeriodKey,
  shouldRunCatchUp,
} from './index'

describe('periodKeyFor', () => {
  it('harian memakai businessDate apa adanya', () => {
    expect(periodKeyFor('DAILY', '2026-09-18')).toBe('2026-09-18')
  })

  it('bulanan memakai bulan kalender WIB', () => {
    expect(periodKeyFor('MONTHLY', '2026-09-18')).toBe('2026-09')
    expect(periodKeyFor('MONTHLY', '2026-12-31')).toBe('2026-12')
  })

  it('mingguan memakai ISO week-year, bukan tahun kalender', () => {
    // Jebakan docs/reporting.md §6.1: 2026-01-01 jatuh hari Kamis, sehingga
    // minggunya dimulai Senin 29 Desember 2025 dan bernama 2026-W01.
    expect(periodKeyFor('WEEKLY', '2025-12-29')).toBe('2026-W01')
    expect(periodKeyFor('WEEKLY', '2026-01-01')).toBe('2026-W01')
    expect(periodKeyFor('WEEKLY', '2026-09-18')).toBe('2026-W38')
  })
})

describe('periodRange', () => {
  it('harian: satu hari', () => {
    expect(periodRange('DAILY', '2026-09-18')).toEqual({ from: '2026-09-18', to: '2026-09-18' })
  })

  it('bulanan: tanggal 1 sampai hari terakhir, termasuk Februari kabisat', () => {
    expect(periodRange('MONTHLY', '2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(periodRange('MONTHLY', '2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(periodRange('MONTHLY', '2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('mingguan: Senin sampai Minggu', () => {
    expect(periodRange('WEEKLY', '2026-W38')).toEqual({ from: '2026-09-14', to: '2026-09-20' })
  })

  it('mingguan yang melintasi tahun tetap benar', () => {
    // 2026-W01 dimulai 29 Desember 2025 — kunci mingguannya milik 2026.
    expect(periodRange('WEEKLY', '2026-W01')).toEqual({ from: '2025-12-29', to: '2026-01-04' })
  })

  it('menolak minggu ke-53 pada tahun yang tidak punya', () => {
    // Tahun ISO punya 53 minggu kalau 1 Januari jatuh Kamis, atau tahun kabisat
    // yang 1 Januari-nya Rabu. 2025 tidak keduanya (1 Jan 2025 = Rabu, bukan
    // kabisat), jadi 2025-W53 memang tidak ada.
    expect(() => periodRange('WEEKLY', '2025-W53')).toThrow(ScheduleError)

    // Yang punya 53 minggu tetap diterima: 2026 (1 Jan Kamis) dan 2020
    // (kabisat, 1 Jan Rabu).
    expect(periodRange('WEEKLY', '2026-W53')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
    expect(periodRange('WEEKLY', '2020-W53')).toEqual({ from: '2020-12-28', to: '2021-01-03' })
  })

  it('menolak kunci yang bentuknya salah', () => {
    expect(() => periodRange('DAILY', '2026-9-8')).toThrow(ScheduleError)
    expect(() => periodRange('WEEKLY', '2026-38')).toThrow(ScheduleError)
    expect(() => periodRange('MONTHLY', '2026-09-18')).toThrow(ScheduleError)
  })
})

describe('nextPeriodKey / previousPeriodKey', () => {
  it('berjalan melewati batas bulan dan tahun', () => {
    expect(nextPeriodKey('DAILY', '2026-09-30')).toBe('2026-10-01')
    expect(nextPeriodKey('DAILY', '2026-12-31')).toBe('2027-01-01')
    expect(nextPeriodKey('MONTHLY', '2026-12')).toBe('2027-01')
    expect(nextPeriodKey('WEEKLY', '2025-W52')).toBe('2026-W01')
    expect(previousPeriodKey('WEEKLY', '2026-W01')).toBe('2025-W52')
    expect(previousPeriodKey('MONTHLY', '2026-01')).toBe('2025-12')
  })
})

describe('isPeriodComplete', () => {
  it('hari ini tidak pernah dianggap selesai', () => {
    expect(isPeriodComplete('DAILY', '2026-09-18', '2026-09-18')).toBe(false)
    expect(isPeriodComplete('DAILY', '2026-09-17', '2026-09-18')).toBe(true)
  })

  it('minggu berjalan belum selesai sampai hari Minggu berlalu', () => {
    // 2026-W38 berakhir Minggu 20 September.
    expect(isPeriodComplete('WEEKLY', '2026-W38', '2026-09-20')).toBe(false)
    expect(isPeriodComplete('WEEKLY', '2026-W38', '2026-09-21')).toBe(true)
  })

  it('bulan berjalan belum selesai sampai tanggal 1 bulan berikutnya', () => {
    expect(isPeriodComplete('MONTHLY', '2026-09', '2026-09-30')).toBe(false)
    expect(isPeriodComplete('MONTHLY', '2026-09', '2026-10-01')).toBe(true)
  })
})

describe('missingPeriods — "server mati 3 hari"', () => {
  it('menghasilkan tepat 3 hari yang terlewat, urut, tanpa hari ini', () => {
    const periods = missingPeriods({
      kind: 'DAILY',
      lastSentKey: '2026-09-14',
      earliestKey: null,
      today: '2026-09-18',
    })

    expect(periods).toEqual(['2026-09-15', '2026-09-16', '2026-09-17'])
  })

  it('tidak menghasilkan apa pun kalau sudah terkirim sampai kemarin', () => {
    expect(
      missingPeriods({
        kind: 'DAILY',
        lastSentKey: '2026-09-17',
        earliestKey: null,
        today: '2026-09-18',
      }),
    ).toEqual([])
  })

  it('instalasi baru mulai dari transaksi paling awal', () => {
    const periods = missingPeriods({
      kind: 'DAILY',
      lastSentKey: null,
      earliestKey: '2026-09-16',
      today: '2026-09-18',
    })
    expect(periods).toEqual(['2026-09-16', '2026-09-17'])
  })

  it('belum ada transaksi sama sekali berarti tidak ada yang dilaporkan', () => {
    expect(
      missingPeriods({ kind: 'DAILY', lastSentKey: null, earliestKey: null, today: '2026-09-18' }),
    ).toEqual([])
  })

  it('backlog dipotong oleh cap, dan yang disisakan adalah yang TERBARU', () => {
    const periods = missingPeriods({
      kind: 'DAILY',
      lastSentKey: '2026-01-01',
      earliestKey: null,
      today: '2026-09-18',
      cap: 5,
    })

    // Laptop mati enam bulan tidak boleh mengirim 180 pesan bertubi-tubi.
    expect(periods).toHaveLength(5)
    expect(periods.at(-1)).toBe('2026-09-17')
    expect(periods[0]).toBe('2026-09-13')
  })

  it('cap bawaan 60 periode', () => {
    const periods = missingPeriods({
      kind: 'DAILY',
      lastSentKey: '2020-01-01',
      earliestKey: null,
      today: '2026-09-18',
    })
    expect(periods).toHaveLength(DEFAULT_BACKLOG_CAP)
  })

  it('mingguan melewati pergantian tahun tanpa melompat atau mengulang', () => {
    const periods = missingPeriods({
      kind: 'WEEKLY',
      lastSentKey: '2025-W51',
      earliestKey: null,
      today: '2026-01-20',
    })

    // 2026-W01 dimulai 29 Desember 2025, jadi W03 (12–18 Januari) sudah selesai
    // pada 20 Januari. Minggu berjalan (W04, 19–25 Januari) tidak ikut.
    expect(periods).toEqual(['2025-W52', '2026-W01', '2026-W02', '2026-W03'])
  })

  it('bulanan melewati pergantian tahun', () => {
    const periods = missingPeriods({
      kind: 'MONTHLY',
      lastSentKey: '2025-11',
      earliestKey: null,
      today: '2026-02-05',
    })
    expect(periods).toEqual(['2025-12', '2026-01'])
  })

  it('menolak cap yang tidak masuk akal', () => {
    expect(() =>
      missingPeriods({
        kind: 'DAILY',
        lastSentKey: '2026-09-14',
        earliestKey: null,
        today: '2026-09-18',
        cap: 0,
      }),
    ).toThrow(ScheduleError)
  })
})

describe('shouldRunCatchUp', () => {
  const now = new Date('2026-09-18T10:00:00Z')

  it('selalu jalan kalau belum pernah', () => {
    expect(
      shouldRunCatchUp({
        now,
        today: '2026-09-18',
        lastRunAt: null,
        lastRunBusinessDate: null,
      }),
    ).toBe(true)
  })

  it('jalan begitu hari usaha berganti', () => {
    expect(
      shouldRunCatchUp({
        now,
        today: '2026-09-18',
        lastRunAt: new Date(now.getTime() - 60_000),
        lastRunBusinessDate: '2026-09-17',
      }),
    ).toBe(true)
  })

  it('TIDAK jalan tiap menit — database yang sama sedang dipakai kasir', () => {
    expect(
      shouldRunCatchUp({
        now,
        today: '2026-09-18',
        lastRunAt: new Date(now.getTime() - 60_000),
        lastRunBusinessDate: '2026-09-18',
      }),
    ).toBe(false)
  })

  it('jalan lagi setelah jeda cukup, untuk memungut kiriman yang gagal', () => {
    expect(
      shouldRunCatchUp({
        now,
        today: '2026-09-18',
        lastRunAt: new Date(now.getTime() - 11 * 60_000),
        lastRunBusinessDate: '2026-09-18',
      }),
    ).toBe(true)
  })
})
