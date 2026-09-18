import { describe, expect, it } from 'vitest'
import {
  MAX_RUPIAH_COLUMN,
  MoneyError,
  assertRupiah,
  assertSafeTotal,
  formatRupiah,
  parseRupiah,
  percentToRupiah,
  roundRupiah,
} from './index'

describe('formatRupiah', () => {
  it('memformat dengan pemisah ribuan titik', () => {
    expect(formatRupiah(0)).toBe('Rp 0')
    expect(formatRupiah(5)).toBe('Rp 5')
    expect(formatRupiah(500)).toBe('Rp 500')
    expect(formatRupiah(1000)).toBe('Rp 1.000')
    expect(formatRupiah(15000)).toBe('Rp 15.000')
    expect(formatRupiah(48500)).toBe('Rp 48.500')
    expect(formatRupiah(100000)).toBe('Rp 100.000')
    expect(formatRupiah(1234567)).toBe('Rp 1.234.567')
    expect(formatRupiah(MAX_RUPIAH_COLUMN)).toBe('Rp 2.147.483.647')
  })

  it('mendukung mode bare tanpa awalan Rp', () => {
    expect(formatRupiah(15000, { bare: true })).toBe('15.000')
    expect(formatRupiah(0, { bare: true })).toBe('0')
  })

  it('memakai tanda minus untuk nilai negatif (selisih kas)', () => {
    expect(formatRupiah(-5000)).toBe('−Rp 5.000')
    expect(formatRupiah(-5000, { bare: true })).toBe('−5.000')
  })

  it('tidak pernah menghasilkan pemisah di posisi salah', () => {
    // Batas 3/4/6/7 digit adalah tempat bug off-by-one biasa muncul.
    expect(formatRupiah(999)).toBe('Rp 999')
    expect(formatRupiah(1001)).toBe('Rp 1.001')
    expect(formatRupiah(999999)).toBe('Rp 999.999')
    expect(formatRupiah(1000000)).toBe('Rp 1.000.000')
  })

  it('menolak nilai non-finite', () => {
    expect(() => formatRupiah(Number.NaN)).toThrow(MoneyError)
    expect(() => formatRupiah(Number.POSITIVE_INFINITY)).toThrow(MoneyError)
  })
})

describe('parseRupiah', () => {
  it('menerima berbagai bentuk input kasir', () => {
    expect(parseRupiah('15000')).toBe(15000)
    expect(parseRupiah('15.000')).toBe(15000)
    expect(parseRupiah('Rp 15.000')).toBe(15000)
    expect(parseRupiah('Rp15000')).toBe(15000)
    expect(parseRupiah('rp 1.234.567')).toBe(1234567)
    expect(parseRupiah('  50000  ')).toBe(50000)
    expect(parseRupiah('0')).toBe(0)
  })

  it('mengembalikan null untuk input kosong, bukan 0', () => {
    // Membedakan "belum diisi" dari "nol" penting di input kas awal.
    expect(parseRupiah('')).toBeNull()
    expect(parseRupiah('   ')).toBeNull()
  })

  it('melempar untuk input yang bukan angka, tidak diam-diam jadi 0', () => {
    expect(() => parseRupiah('abc')).toThrow(MoneyError)
    expect(() => parseRupiah('15rb')).toThrow(MoneyError)
    expect(() => parseRupiah('-5000')).toThrow(MoneyError)
    expect(() => parseRupiah('15.0o0')).toThrow(MoneyError)
  })

  it('bolak-balik dengan formatRupiah', () => {
    for (const v of [0, 1, 999, 1000, 15000, 48500, 1234567, MAX_RUPIAH_COLUMN]) {
      expect(parseRupiah(formatRupiah(v))).toBe(v)
      expect(parseRupiah(formatRupiah(v, { bare: true }))).toBe(v)
    }
  })
})

describe('roundRupiah', () => {
  it('membulatkan half-up', () => {
    expect(roundRupiah(2803.4)).toBe(2803)
    expect(roundRupiah(2803.5)).toBe(2804)
    expect(roundRupiah(2803.6)).toBe(2804)
    expect(roundRupiah(0.5)).toBe(1)
    expect(roundRupiah(0.4)).toBe(0)
  })

  it('menolak negatif supaya asumsi half-up tidak dilanggar', () => {
    expect(() => roundRupiah(-0.5)).toThrow(MoneyError)
  })
})

describe('percentToRupiah', () => {
  it('menghitung diskon persen menjadi rupiah integer', () => {
    expect(percentToRupiah(100000, 10)).toBe(10000)
    expect(percentToRupiah(53500, 10)).toBe(5350)
    expect(percentToRupiah(7000, 2.5)).toBe(175)
    expect(percentToRupiah(15000, 0)).toBe(0)
    expect(percentToRupiah(15000, 100)).toBe(15000)
  })

  it('membulatkan sekali, hasilnya selalu integer', () => {
    // 3333 * 33% = 1099.89 → 1100
    expect(percentToRupiah(3333, 33)).toBe(1100)
    expect(Number.isInteger(percentToRupiah(9991, 7.77))).toBe(true)
  })

  it('tidak pernah melebihi base sehingga total tidak bisa negatif', () => {
    expect(percentToRupiah(1, 100)).toBe(1)
    expect(percentToRupiah(0, 100)).toBe(0)
  })

  it('menolak persen di luar 0..100', () => {
    expect(() => percentToRupiah(1000, -1)).toThrow(MoneyError)
    expect(() => percentToRupiah(1000, 101)).toThrow(MoneyError)
    expect(() => percentToRupiah(1000, Number.NaN)).toThrow(MoneyError)
  })
})

describe('assertRupiah', () => {
  it('meloloskan integer non-negatif dalam batas kolom', () => {
    expect(assertRupiah(0)).toBe(0)
    expect(assertRupiah(48500)).toBe(48500)
    expect(assertRupiah(MAX_RUPIAH_COLUMN)).toBe(MAX_RUPIAH_COLUMN)
  })

  it('menolak pecahan, negatif, dan yang melewati ceiling Int 32-bit', () => {
    expect(() => assertRupiah(1.5)).toThrow(MoneyError)
    expect(() => assertRupiah(-1)).toThrow(MoneyError)
    expect(() => assertRupiah(MAX_RUPIAH_COLUMN + 1)).toThrow(MoneyError)
  })
})

describe('assertSafeTotal', () => {
  it('mengizinkan agregat jauh di atas ceiling kolom', () => {
    // Omzet setahun bisa melewati Int 32-bit; agregat memang bukan kolom Int.
    const setahun = 10_000_000 * 365
    expect(setahun).toBeGreaterThan(MAX_RUPIAH_COLUMN)
    expect(assertSafeTotal(setahun)).toBe(setahun)
  })

  it('menolak yang melewati MAX_SAFE_INTEGER', () => {
    expect(() => assertSafeTotal(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError)
  })
})
