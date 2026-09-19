import { describe, expect, it } from 'vitest'
import { aggregateSales, compareValue, type ReportInput, type ReportTransactionRow } from './index'
import { formatLongDate, periodLabel } from './labels'

/**
 * Fixture docs/reporting.md §3.1 dipakai apa adanya.
 *
 * Angka-angkanya bukan ilustrasi: kalau kode dan dokumen berbeda, salah satunya
 * bug, dan test inilah yang memaksa perbedaan itu ketahuan.
 */
const TRX_FIXTURE: ReportTransactionRow = {
  id: 'trx-1',
  businessDate: '2026-09-18',
  status: 'COMPLETED',
  grossSubtotal: 54_500,
  itemDiscountTotal: 1_000,
  transactionDiscount: 5_000,
  netTotal: 48_500,
  cogsTotal: 39_500,
  paidMethod: 'CASH',
  items: [
    { productId: 'A', productName: 'Barang A', qty: 2, lineFinal: 27_196, unitCost: 11_000 },
    { productId: 'B', productName: 'Barang B', qty: 3, lineFinal: 18_131, unitCost: 5_000 },
    { productId: 'C', productName: 'Barang C', qty: 1, lineFinal: 3_173, unitCost: 2_500 },
  ],
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    transactions: [],
    refunds: [],
    expenses: [],
    shifts: [],
    stock: [],
    ...overrides,
  }
}

describe('aggregateSales — fixture reporting.md §3.1', () => {
  it('menghasilkan angka yang sama persis dengan dokumen', () => {
    const a = aggregateSales(input({ transactions: [TRX_FIXTURE] }))

    expect(a.grossSales).toBe(54_500)
    expect(a.discounts).toBe(6_000)
    expect(a.netSales).toBe(48_500)
    expect(a.cogs).toBe(39_500)
    expect(a.grossProfit).toBe(9_000)
    expect(a.transactionCount).toBe(1)
    expect(a.itemCount).toBe(6)
    expect(a.averageTransaction).toBe(48_500)
  })

  it('refund 1 unit item B menghasilkan angka §3.2 apa adanya', () => {
    const a = aggregateSales(
      input({
        transactions: [TRX_FIXTURE],
        refunds: [
          {
            id: 'r1',
            businessDate: '2026-09-18',
            amount: 6_043,
            cogsAmount: 5_000,
            method: 'CASH',
          },
        ],
      }),
    )

    expect(a.refunds).toBe(6_043)
    expect(a.netSalesAfterRefunds).toBe(42_457)
    // Laba kotor hanya berkurang sebesar marginnya: uang keluar 6.043, tapi
    // barang senilai HPP 5.000 kembali ke rak.
    expect(a.grossProfitAfterRefunds).toBe(7_957)
    expect(a.grossProfitAfterRefunds).toBe(a.grossProfit - (a.refunds - a.refundedCogs))
  })

  it('Σ lineFinal cocok dengan netTotal, sehingga laporan tidak kehilangan rupiah', () => {
    const total = TRX_FIXTURE.items.reduce((s, i) => s + i.lineFinal, 0)
    expect(total).toBe(TRX_FIXTURE.netTotal)
  })
})

describe('penyaringan status', () => {
  const voided: ReportTransactionRow = { ...TRX_FIXTURE, id: 'v', status: 'VOIDED' }
  const cancelled: ReportTransactionRow = { ...TRX_FIXTURE, id: 'c', status: 'CANCELLED' }
  const pending: ReportTransactionRow = { ...TRX_FIXTURE, id: 'p', status: 'PENDING' }

  it('VOIDED tidak masuk penjualan, tidak juga sebagai angka negatif', () => {
    const a = aggregateSales(input({ transactions: [TRX_FIXTURE, voided] }))

    expect(a.netSales).toBe(48_500)
    expect(a.transactionCount).toBe(1)
    expect(a.itemCount).toBe(6)
    // Tetap terlihat sebagai indikator pengawasan.
    expect(a.voidCount).toBe(1)
  })

  it('CANCELLED dan PENDING juga dikecualikan dari ketiga angka Aktivitas', () => {
    const a = aggregateSales(input({ transactions: [TRX_FIXTURE, cancelled, pending] }))

    expect(a.transactionCount).toBe(1)
    expect(a.itemCount).toBe(6)
    expect(a.netSales).toBe(48_500)
    expect(a.cancelledCount).toBe(1)
  })

  it('kalau VOIDED ikut terhitung, rata-rata per transaksi akan turun tanpa sebab nyata', () => {
    const hanyaSah = aggregateSales(input({ transactions: [TRX_FIXTURE] }))
    const denganVoid = aggregateSales(input({ transactions: [TRX_FIXTURE, voided] }))

    // Justru inilah yang dicegah: angka yang bergerak karena kesalahan input
    // kasir, bukan karena perilaku pelanggan.
    expect(denganVoid.averageTransaction).toBe(hanyaSah.averageTransaction)
  })
})

describe('pembagian dengan nol', () => {
  it('tanpa transaksi, rata-rata bernilai null — bukan 0 dan bukan NaN', () => {
    const a = aggregateSales(input())
    expect(a.transactionCount).toBe(0)
    expect(a.averageTransaction).toBeNull()
    expect(a.netSales).toBe(0)
  })

  it('periode sebelumnya 0 membuat persentase null, bukan Infinity', () => {
    const naik = compareValue(500_000, 0)
    expect(naik.delta).toBe(500_000)
    expect(naik.percent).toBeNull()

    const turun = compareValue(0, 250_000)
    expect(turun.percent).toBe(-100)
  })
})

describe('rincian', () => {
  it('memisahkan metode pembayaran berdasarkan pembayaran yang LUNAS', () => {
    const qris: ReportTransactionRow = {
      ...TRX_FIXTURE,
      id: 'q',
      netTotal: 10_000,
      grossSubtotal: 10_000,
      itemDiscountTotal: 0,
      transactionDiscount: 0,
      cogsTotal: 6_000,
      paidMethod: 'QRIS_STATIC',
      items: [{ productId: 'D', productName: 'Barang D', qty: 1, lineFinal: 10_000, unitCost: 6_000 }],
    }
    const a = aggregateSales(input({ transactions: [TRX_FIXTURE, qris] }))

    expect(a.byMethod).toEqual([
      { method: 'CASH', count: 1, amount: 48_500 },
      { method: 'QRIS_STATIC', count: 1, amount: 10_000 },
    ])
  })

  it('daftar terlaris dan daftar penyumbang laba memang bisa berbeda urutan', () => {
    const a = aggregateSales(input({ transactions: [TRX_FIXTURE] }))

    // B terjual paling banyak (3), tapi A menyumbang laba paling besar
    // (27.196 − 22.000 = 5.196 vs 18.131 − 15.000 = 3.131).
    expect(a.topByQty[0]?.productName).toBe('Barang B')
    expect(a.topByProfit[0]?.productName).toBe('Barang A')
    expect(a.topByProfit[0]?.grossProfit).toBe(5_196)
  })

  it('pengeluaran dipisah antara yang menyentuh laci dan yang tidak', () => {
    const a = aggregateSales(
      input({
        expenses: [
          { businessDate: '2026-09-18', kategori: 'Listrik', amount: 150_000, paidFrom: 'CASH_DRAWER' },
          { businessDate: '2026-09-18', kategori: 'Sewa', amount: 500_000, paidFrom: 'OTHER' },
          { businessDate: '2026-09-18', kategori: 'Listrik', amount: 50_000, paidFrom: 'CASH_DRAWER' },
        ],
      }),
    )

    expect(a.expenseTotal).toBe(700_000)
    expect(a.expenseFromCashDrawer).toBe(200_000)
    expect(a.expenseFromOther).toBe(500_000)
    expect(a.expensesByCategory[0]).toEqual({ kategori: 'Sewa', amount: 500_000 })
    expect(a.expensesByCategory[1]).toEqual({ kategori: 'Listrik', amount: 200_000 })
  })

  it('selisih kas dijumlahkan apa adanya, termasuk yang negatif', () => {
    const a = aggregateSales(
      input({
        shifts: [
          {
            cashierName: 'Budi',
            status: 'CLOSED',
            businessDate: '2026-09-18',
            openedAt: new Date('2026-09-18T01:00:00Z'),
            closedAt: new Date('2026-09-18T09:00:00Z'),
            expectedCash: 1_240_000,
            countedCash: 1_235_000,
            difference: -5_000,
          },
          {
            cashierName: 'Sari',
            status: 'CLOSED',
            businessDate: '2026-09-18',
            openedAt: new Date('2026-09-18T09:00:00Z'),
            closedAt: new Date('2026-09-18T15:00:00Z'),
            expectedCash: 980_000,
            countedCash: 982_000,
            difference: 2_000,
          },
        ],
      }),
    )

    expect(a.cashDifferenceTotal).toBe(-3_000)
  })

  it('hanya stok bermasalah yang diteruskan ke laporan', () => {
    const a = aggregateSales(
      input({
        stock: [
          { productName: 'Gula', stok: -2, stokMinimum: 5, satuan: 'kg' },
          { productName: 'Teh', stok: 3, stokMinimum: 5, satuan: 'botol' },
        ],
      }),
    )
    expect(a.stockAlerts).toHaveLength(2)
  })
})

describe('label periode', () => {
  it('menulis tanggal sebagai tanggal sipil, bebas dari zona mesin', () => {
    expect(formatLongDate('2026-09-18')).toBe('Jumat, 18 September 2026')
    expect(periodLabel('DAILY', '2026-09-18')).toBe('Jumat, 18 September 2026')
    expect(periodLabel('MONTHLY', '2026-09')).toBe('September 2026')
  })

  it('kode minggu ISO selalu disertai tanggalnya, karena kodenya tidak berarti bagi pemilik', () => {
    // 2026-W38 dimulai Senin 14 September 2026 (docs/reporting.md §6.1).
    expect(periodLabel('WEEKLY', '2026-W38')).toBe(
      'Minggu 2026-W38 · 14 September–Minggu, 20 September 2026',
    )
  })
})
