import { describe, expect, it } from 'vitest'
import { buildReceipt, receiptPageWidth, type ReceiptSource, type ReceiptStore } from './index'

const STORE: ReceiptStore = {
  name: 'Toko Saya',
  address: 'Jl. Merdeka 1',
  phone: '0812',
  footer: 'Terima kasih',
}

/** Fixture docs/reporting.md §3.1, dibayar tunai Rp 50.000. */
const SOURCE: ReceiptSource = {
  trxNumber: 'TRX-20260919-000123',
  createdAt: new Date('2026-09-19T03:05:00Z'), // 10:05 WIB
  cashierName: 'Budi',
  items: [
    { productName: 'Item A', sku: 'A', qty: 2, unitPrice: 15_000, itemDiscount: 0, allocatedTxDiscount: 2_804, lineGross: 30_000, lineFinal: 27_196 },
    { productName: 'Item B', sku: 'B', qty: 3, unitPrice: 7_000, itemDiscount: 1_000, allocatedTxDiscount: 1_869, lineGross: 21_000, lineFinal: 18_131 },
    { productName: 'Item C', sku: 'C', qty: 1, unitPrice: 3_500, itemDiscount: 0, allocatedTxDiscount: 327, lineGross: 3_500, lineFinal: 3_173 },
  ],
  grossSubtotal: 54_500,
  itemDiscountTotal: 1_000,
  transactionDiscount: 5_000,
  netTotal: 48_500,
  paymentMethod: 'CASH',
  amountTendered: 50_000,
  changeAmount: 1_500,
  status: 'COMPLETED',
}

describe('buildReceipt', () => {
  const model = buildReceipt(SOURCE, STORE, 'Asia/Jakarta')

  it('memakai waktu WIB, bukan UTC', () => {
    expect(model.dateLabel).toBe('19/09/2026')
    expect(model.timeLabel).toBe('10:05')
  })

  it('satu baris per item dengan qty dan harga satuan', () => {
    expect(model.lines).toHaveLength(3)
    expect(model.lines[1]?.name).toBe('Item B')
    expect(model.lines[1]?.qtyPrice).toBe('3 × 7.000')
  })

  it('menggabungkan diskon item dan bagian diskon transaksi per baris', () => {
    // Item B: 1.000 diskon item + 1.869 bagian diskon transaksi = 2.869.
    expect(model.lines[1]?.discountLabel).toBe('Diskon −2.869')
    // Item A tidak punya diskon item, tapi kebagian diskon transaksi.
    expect(model.lines[0]?.discountLabel).toBe('Diskon −2.804')
  })

  it('nominal per baris adalah lineFinal, yang benar-benar dibayar', () => {
    expect(model.lines.map((l) => l.amount)).toEqual(['27.196', '18.131', '3.173'])
  })

  it('rincian total sesuai fixture', () => {
    const byLabel = new Map(model.totals.map((t) => [t.label, t.value]))
    expect(byLabel.get('Subtotal')).toBe('54.500')
    expect(byLabel.get('Diskon item')).toBe('−1.000')
    expect(byLabel.get('Diskon transaksi')).toBe('−5.000')
    expect(byLabel.get('TOTAL')).toBe('48.500')
    expect(byLabel.get('Tunai')).toBe('50.000')
    expect(byLabel.get('Kembali')).toBe('1.500')
  })

  it('baris TOTAL ditandai untuk ditebalkan', () => {
    expect(model.totals.find((t) => t.label === 'TOTAL')?.emphasis).toBe(true)
  })

  it('transaksi lunas tidak punya penanda draft', () => {
    expect(model.draftNotice).toBeNull()
  })

  it('baris diskon disembunyikan kalau tidak ada diskon', () => {
    const polos = buildReceipt(
      {
        ...SOURCE,
        items: [{ ...SOURCE.items[0]!, allocatedTxDiscount: 0, lineFinal: 30_000 }],
        itemDiscountTotal: 0,
        transactionDiscount: 0,
        grossSubtotal: 30_000,
        netTotal: 30_000,
        amountTendered: 30_000,
        changeAmount: 0,
      },
      STORE,
      'Asia/Jakarta',
    )
    const labels = polos.totals.map((t) => t.label)
    expect(labels).not.toContain('Diskon item')
    expect(labels).not.toContain('Diskon transaksi')
    expect(polos.lines[0]?.discountLabel).toBeNull()
  })

  it('QRIS tidak menampilkan baris tunai dan kembalian', () => {
    const qris = buildReceipt(
      { ...SOURCE, paymentMethod: 'QRIS_STATIC', amountTendered: null, changeAmount: null },
      STORE,
      'Asia/Jakarta',
    )
    expect(qris.paymentLabel).toBe('QRIS')
    const labels = qris.totals.map((t) => t.label)
    expect(labels).not.toContain('Tunai')
    expect(labels).not.toContain('Kembali')
  })

  it('transaksi belum lunas ditandai jelas, bukan terlihat seperti bukti bayar', () => {
    const draft = buildReceipt({ ...SOURCE, status: 'PENDING' }, STORE, 'Asia/Jakarta')
    expect(draft.draftNotice).toContain('BELUM LUNAS')
  })

  it('transaksi dibatalkan ditandai sebagai dibatalkan', () => {
    const voided = buildReceipt({ ...SOURCE, status: 'VOIDED' }, STORE, 'Asia/Jakarta')
    expect(voided.draftNotice).toContain('DIBATALKAN')
  })
})

describe('receiptPageWidth', () => {
  it('memetakan preset ke lebar kertas', () => {
    expect(receiptPageWidth('58')).toBe('58mm')
    expect(receiptPageWidth('80')).toBe('80mm')
    expect(receiptPageWidth('a4')).toBe('210mm')
  })
})
