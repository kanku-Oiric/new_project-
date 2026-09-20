import { describe, expect, it } from 'vitest'
import { aggregateSales, type ReportInput, type ReportShiftRow } from '../report'
import { buildReportMessage } from './message'

/**
 * Regresi untuk bug yang ditemukan saat pemeriksaan manual halaman /laporan:
 *
 *   Encountered two children with the same key,
 *   `Shift (jam buka–tutup, bisa melewati tengah malam)-Kasir Budi`
 *
 * Penyebabnya bukan React. Penyebabnya adalah isi pesan: baris shift diberi
 * label nama kasir saja, sehingga kasir yang bekerja tiga hari dalam sepekan
 * menghasilkan tiga baris berjudul sama. Selain membuat React kehilangan
 * identitas baris, laporannya sendiri jadi tidak bisa dibaca — tidak ada cara
 * tahu baris mana hari mana.
 *
 * Diperbaiki di sumbernya (label memuat tanggal untuk periode multi-hari), dan
 * halaman laporan tidak lagi memakai isi data sebagai key React.
 */

function shift(cashierName: string, businessDate: string, jam: string): ReportShiftRow {
  return {
    cashierName,
    status: 'CLOSED',
    businessDate,
    openedAt: new Date(`${businessDate}T${jam}:00Z`),
    closedAt: new Date(`${businessDate}T13:00:00Z`),
    expectedCash: 100_000,
    countedCash: 100_000,
    difference: 0,
  }
}

function inputDenganShift(shifts: ReportShiftRow[]): ReportInput {
  return { transactions: [], refunds: [], expenses: [], shifts, stock: [] }
}

const META = {
  periodKey: '2026-W38',
  periodLabel: 'Pekan 38',
  storeName: 'Toko Uji',
  timezone: 'Asia/Jakarta',
}

describe('buildReportMessage — keunikan label baris', () => {
  it('dua shift kasir yang SAMA dalam sepekan menghasilkan label berbeda', () => {
    const aggregate = aggregateSales(
      inputDenganShift([
        shift('Kasir Budi', '2026-09-14', '01'),
        shift('Kasir Budi', '2026-09-16', '01'),
      ]),
    )

    const pesan = buildReportMessage(aggregate, { ...META, kind: 'WEEKLY' })
    const bagian = pesan.sections.find((s) => s.label.startsWith('Shift'))
    expect(bagian).toBeDefined()

    const labels = bagian?.rows.map((r) => r.label) ?? []
    expect(labels).toHaveLength(2)
    expect(new Set(labels).size).toBe(2)
    // Tanggalnya harus terbaca, bukan sekadar dibedakan dengan angka acak.
    expect(labels[0]).toContain('2026-09-14')
    expect(labels[1]).toContain('2026-09-16')
  })

  it('laporan HARIAN tetap memakai nama kasir saja', () => {
    // Dalam satu hari, tanggalnya sama untuk semua baris — mencantumkannya hanya
    // menambah kebisingan pada laporan yang paling sering dibaca.
    const aggregate = aggregateSales(inputDenganShift([shift('Kasir Budi', '2026-09-14', '01')]))
    const pesan = buildReportMessage(aggregate, {
      ...META,
      kind: 'DAILY',
      periodKey: '2026-09-14',
    })
    const bagian = pesan.sections.find((s) => s.label.startsWith('Shift'))
    expect(bagian?.rows[0]?.label).toBe('Kasir Budi')
  })

  it('TIDAK ADA bagian mana pun yang punya dua baris berlabel sama', () => {
    // Invarian yang diandalkan halaman /laporan. Diperiksa menyeluruh, bukan
    // hanya untuk bagian shift, supaya bug yang sama tidak muncul lagi di
    // bagian lain saat seseorang menambah baris baru.
    const aggregate = aggregateSales({
      transactions: [
        {
          id: 't1',
          businessDate: '2026-09-14',
          status: 'COMPLETED',
          grossSubtotal: 20_000,
          itemDiscountTotal: 0,
          transactionDiscount: 0,
          netTotal: 20_000,
          cogsTotal: 12_000,
          passthroughTotal: 0,
          serviceFeeTotal: 0,
          services: [],
          paidMethod: 'CASH',
          items: [
            { productId: 'p1', productName: 'Kopi', qty: 2, lineFinal: 20_000, unitCost: 6_000 },
          ],
        },
        {
          id: 't2',
          businessDate: '2026-09-16',
          status: 'COMPLETED',
          grossSubtotal: 15_000,
          itemDiscountTotal: 0,
          transactionDiscount: 0,
          netTotal: 15_000,
          cogsTotal: 9_000,
          passthroughTotal: 0,
          serviceFeeTotal: 0,
          services: [],
          paidMethod: 'QRIS_STATIC',
          items: [
            { productId: 'p2', productName: 'Teh', qty: 1, lineFinal: 15_000, unitCost: 9_000 },
          ],
        },
      ],
      refunds: [],
      expenses: [
        { businessDate: '2026-09-14', kategori: 'Operasional', amount: 5_000, paidFrom: 'CASH_DRAWER' },
        { businessDate: '2026-09-16', kategori: 'Operasional', amount: 7_000, paidFrom: 'CASH_DRAWER' },
      ],
      shifts: [
        shift('Kasir Budi', '2026-09-14', '01'),
        shift('Kasir Budi', '2026-09-16', '01'),
        shift('Kasir Sari', '2026-09-16', '02'),
      ],
      stock: [],
    })

    const pesan = buildReportMessage(aggregate, { ...META, kind: 'WEEKLY' })

    const bermasalah: string[] = []
    for (const bagian of pesan.sections) {
      const labels = bagian.rows.map((r) => r.label)
      if (new Set(labels).size !== labels.length) {
        bermasalah.push(`${bagian.label}: ${labels.join(' | ')}`)
      }
    }

    expect(bermasalah).toEqual([])
  })
})
