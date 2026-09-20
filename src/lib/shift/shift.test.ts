import { describe, expect, it } from 'vitest'
import { buildShiftSummary, cashDifference, expectedCash, type ShiftCashInputs } from './index'

/** Shift kosong. Test menimpa hanya angka yang sedang diuji. */
function kas(over: Partial<ShiftCashInputs> = {}): ShiftCashInputs {
  return {
    openingCash: 0,
    cashSales: 0,
    cashRefunds: 0,
    cashExpenses: 0,
    cashProviderTopups: 0,
    cashServicePayouts: 0,
    ...over,
  }
}

describe('expectedCash', () => {
  it('kas awal + penjualan tunai − refund tunai − pengeluaran kas', () => {
    expect(
      expectedCash(
        kas({
          openingCash: 200_000,
          cashSales: 1_250_000,
          cashRefunds: 35_000,
          cashExpenses: 175_000,
        }),
      ),
    ).toBe(1_240_000)
  })

  it('shift tanpa transaksi mengembalikan kas awal', () => {
    expect(expectedCash(kas({ openingCash: 200_000 }))).toBe(200_000)
  })

  it('boleh negatif kalau pengeluaran melebihi kas yang ada', () => {
    // Keadaan nyata yang harus terlihat, bukan dipaksa jadi nol.
    expect(expectedCash(kas({ openingCash: 50_000, cashExpenses: 80_000 }))).toBe(-30_000)
  })

  it('menolak masukan negatif atau pecahan', () => {
    expect(() => expectedCash(kas({ openingCash: -1 }))).toThrow()
    expect(() => expectedCash(kas({ openingCash: 1.5 }))).toThrow()
    expect(() => expectedCash(kas({ cashProviderTopups: -1 }))).toThrow()
    expect(() => expectedCash(kas({ cashServicePayouts: 0.5 }))).toThrow()
  })

  it('top-up saldo provider dari laci mengurangi kas yang seharusnya ada', () => {
    // Pemilik mengambil Rp 1.000.000 dari laci untuk mengisi saldo Shopee.
    // Uangnya tidak hilang — ia pindah kantong — tapi laci memang berkurang,
    // dan kalau ini tidak dihitung, kasir akan terlihat kekurangan sejuta rupiah.
    expect(
      expectedCash(kas({ openingCash: 200_000, cashSales: 2_000_000, cashProviderTopups: 1_000_000 })),
    ).toBe(1_200_000)
  })

  it('top-up dari luar laci TIDAK mengurangi kas', () => {
    // Pemilik mengisi saldo lewat transfer dari rekening pribadinya. Saldo
    // provider naik, laci tidak tersentuh. Pemanggil yang menentukan ini lewat
    // `paidFrom`; modul ini hanya melihat angka yang sudah dipilah.
    expect(expectedCash(kas({ openingCash: 200_000, cashProviderTopups: 0 }))).toBe(200_000)
  })

  it('serah tunai (tarik tunai) mengurangi kas', () => {
    // Pelanggan transfer Rp 500.000 ke rekening toko, toko menyerahkan
    // Rp 495.000 tunai dan menyimpan Rp 5.000 sebagai biaya admin.
    // Yang keluar dari laci adalah 495.000.
    expect(
      expectedCash(kas({ openingCash: 1_000_000, cashServicePayouts: 495_000 })),
    ).toBe(505_000)
  })

  it('titipan jasa yang diterima tunai MEMANG menambah kas', () => {
    // cashSales menjumlahkan Payment.amount, dan sejak ada jasa angka itu
    // adalah uang yang berpindah — omzet ditambah titipan. Untuk laci itu benar:
    // Rp 102.500 betul-betul masuk ke laci, walaupun omzetnya cuma Rp 2.500.
    expect(expectedCash(kas({ openingCash: 100_000, cashSales: 102_500 }))).toBe(202_500)
  })

  it('semua suku sekaligus', () => {
    expect(
      expectedCash({
        openingCash: 300_000,
        cashSales: 2_500_000,
        cashRefunds: 50_000,
        cashExpenses: 120_000,
        cashProviderTopups: 1_000_000,
        cashServicePayouts: 495_000,
      }),
    ).toBe(300_000 + 2_500_000 - 50_000 - 120_000 - 1_000_000 - 495_000)
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
    ...kas({
      openingCash: 200_000,
      cashSales: 1_250_000,
      cashRefunds: 35_000,
      cashExpenses: 175_000,
    }),
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

  it('ringkasan membawa angka top-up dan serah tunai apa adanya', () => {
    // Dipisah, bukan di-net ke penjualan tunai: kasir harus melihat barisnya
    // sendiri saat tutup shift. Selisih kas yang tidak bisa ditelusuri ke
    // barisnya adalah selisih yang akan disalahkan ke orangnya.
    const s = buildShiftSummary({
      ...base,
      cashProviderTopups: 1_000_000,
      cashServicePayouts: 495_000,
    })
    expect(s.cashProviderTopups).toBe(1_000_000)
    expect(s.cashServicePayouts).toBe(495_000)
    expect(s.expectedCash).toBe(1_240_000 - 1_000_000 - 495_000)
  })
})
