import { describe, expect, it } from 'vitest'
import { buildShiftSummary, cashDifference, expectedCash } from './index'

describe('expectedCash', () => {
  it('kas awal + penjualan tunai − refund tunai − pengeluaran kas', () => {
    expect(
      expectedCash({
        openingCash: 200_000,
        cashSales: 1_250_000,
        cashRefunds: 35_000,
        cashExpenses: 175_000,
      }),
    ).toBe(1_240_000)
  })

  it('shift tanpa transaksi mengembalikan kas awal', () => {
    expect(
      expectedCash({ openingCash: 200_000, cashSales: 0, cashRefunds: 0, cashExpenses: 0 }),
    ).toBe(200_000)
  })

  it('boleh negatif kalau pengeluaran melebihi kas yang ada', () => {
    // Keadaan nyata yang harus terlihat, bukan dipaksa jadi nol.
    expect(
      expectedCash({ openingCash: 50_000, cashSales: 0, cashRefunds: 0, cashExpenses: 80_000 }),
    ).toBe(-30_000)
  })

  it('menolak masukan negatif atau pecahan', () => {
    expect(() =>
      expectedCash({ openingCash: -1, cashSales: 0, cashRefunds: 0, cashExpenses: 0 }),
    ).toThrow()
    expect(() =>
      expectedCash({ openingCash: 1.5, cashSales: 0, cashRefunds: 0, cashExpenses: 0 }),
    ).toThrow()
  })
})

describe('cashDifference', () => {
  it('kurang uang menghasilkan selisih negatif', () => {
    expect(cashDifference(1_235_000, 1_240_000)).toBe(-5_000)
  })

  it('lebih uang menghasilkan selisih positif', () => {
    expect(cashDifference(1_245_000, 1_240_000)).toBe(5_000)
  })

  it('pas menghasilkan nol', () => {
    expect(cashDifference(1_240_000, 1_240_000)).toBe(0)
  })

  it('selisih tidak pernah dibulatkan ke nol', () => {
    // Selisih Rp 1 pun harus terlihat. Yang disembunyikan tidak akan diperiksa.
    expect(cashDifference(1_239_999, 1_240_000)).toBe(-1)
  })
})

describe('buildShiftSummary', () => {
  const base = {
    openingCash: 200_000,
    cashSales: 1_250_000,
    cashRefunds: 35_000,
    cashExpenses: 175_000,
    transactionCount: 42,
    nonCashSales: 300_000,
    pendingCount: 0,
  }

  it('shift yang belum ditutup punya difference null, bukan nol', () => {
    // Membedakan "belum dihitung" dari "pas" itu penting: nol berarti
    // rekonsiliasi sudah dilakukan dan hasilnya cocok.
    const s = buildShiftSummary(base)
    expect(s.expectedCash).toBe(1_240_000)
    expect(s.countedCash).toBeNull()
    expect(s.difference).toBeNull()
  })

  it('shift yang ditutup menghitung selisih', () => {
    const s = buildShiftSummary({ ...base, countedCash: 1_235_000 })
    expect(s.countedCash).toBe(1_235_000)
    expect(s.difference).toBe(-5_000)
  })

  it('membawa jumlah transaksi PENDING yang akan dibatalkan saat tutup', () => {
    const s = buildShiftSummary({ ...base, pendingCount: 3 })
    expect(s.pendingCount).toBe(3)
  })

  it('penjualan non-tunai tidak mempengaruhi expectedCash', () => {
    // QRIS masuk rekening, bukan laci.
    const tanpaQris = buildShiftSummary({ ...base, nonCashSales: 0 })
    const denganQris = buildShiftSummary({ ...base, nonCashSales: 5_000_000 })
    expect(tanpaQris.expectedCash).toBe(denganQris.expectedCash)
  })
})
