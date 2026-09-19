import { describe, expect, it } from 'vitest'
import {
  RefundError,
  computeRefund,
  refundAllRemaining,
  refundAmountFor,
  refundableQty,
  type RefundableItem,
} from './index'

/** Item B dari fixture docs/reporting.md §3.2: lineFinal 18.131, qty 3. */
function itemB(overrides: Partial<RefundableItem> = {}): RefundableItem {
  return {
    transactionItemId: 'b',
    productName: 'Item B',
    unitCost: 5_000,
    qty: 3,
    lineFinal: 18_131,
    refundedQty: 0,
    refundedAmount: 0,
    ...overrides,
  }
}

describe('fixture docs/reporting.md §3.2 — aturan teleskopik', () => {
  it('refund satu per satu menghasilkan 6.043 / 6.044 / 6.044', () => {
    // Tabel di dokumen, dipakai apa adanya.
    const step1 = refundAmountFor(itemB(), 1)
    expect(step1).toBe(6_043)

    const step2 = refundAmountFor(itemB({ refundedQty: 1, refundedAmount: 6_043 }), 1)
    expect(step2).toBe(6_044)

    const step3 = refundAmountFor(itemB({ refundedQty: 2, refundedAmount: 12_087 }), 1)
    expect(step3).toBe(6_044)

    expect(step1 + step2 + step3).toBe(18_131)
  })

  it('refund penuh sekaligus == lineFinal persis', () => {
    expect(refundAmountFor(itemB(), 3)).toBe(18_131)
  })

  it('pembagian naif akan meleset — inilah yang dicegah', () => {
    // round(18.131 / 3) = 6.044; tiga kali = 18.132, satu rupiah LEBIH banyak
    // daripada yang pernah dibayar pelanggan.
    const naif = Math.round(18_131 / 3) * 3
    expect(naif).toBe(18_132)
    expect(naif).not.toBe(18_131)
  })

  it('urutan refund sebagian apa pun tetap berjumlah lineFinal', () => {
    // 1+2, 2+1, dan 3 sekaligus harus sama-sama menghabiskan 18.131.
    for (const urutan of [[1, 2], [2, 1], [3], [1, 1, 1]]) {
      let item = itemB()
      let total = 0
      for (const q of urutan) {
        const amount = refundAmountFor(item, q)
        total += amount
        item = {
          ...item,
          refundedQty: item.refundedQty + q,
          refundedAmount: item.refundedAmount + amount,
        }
      }
      expect(total).toBe(18_131)
      expect(item.refundedQty).toBe(3)
    }
  })

  it('HPP refund adalah perkalian integer, tanpa pembulatan', () => {
    const totals = computeRefund([itemB()], [{ transactionItemId: 'b', qty: 1 }])
    expect(totals.cogsAmount).toBe(5_000)
    expect(totals.amount).toBe(6_043)
  })
})

describe('konservasi rupiah pada banyak kombinasi', () => {
  it('refund penuh selalu == lineFinal untuk ratusan kombinasi qty/nominal', () => {
    let checked = 0
    for (let qty = 1; qty <= 12; qty++) {
      for (let lineFinal = 0; lineFinal <= 40_000; lineFinal += 1_237) {
        // Refund satu per satu sampai habis.
        let item: RefundableItem = {
          transactionItemId: 'x',
          productName: 'X',
          unitCost: 100,
          qty,
          lineFinal,
          refundedQty: 0,
          refundedAmount: 0,
        }
        let total = 0
        for (let i = 0; i < qty; i++) {
          const amount = refundAmountFor(item, 1)
          expect(amount).toBeGreaterThanOrEqual(0)
          total += amount
          item = {
            ...item,
            refundedQty: item.refundedQty + 1,
            refundedAmount: item.refundedAmount + amount,
          }
        }
        expect(total).toBe(lineFinal)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(300)
  })

  it('tepat pada nominal besar tanpa kehilangan presisi float', () => {
    const item: RefundableItem = {
      transactionItemId: 'big',
      productName: 'Besar',
      unitCost: 1,
      qty: 7,
      lineFinal: 2_000_000_000,
      refundedQty: 0,
      refundedAmount: 0,
    }
    expect(refundAmountFor(item, 7)).toBe(2_000_000_000)
  })
})

describe('guard refund berlebih', () => {
  it('menolak qty melebihi sisa', () => {
    expect(() => refundAmountFor(itemB(), 4)).toThrow(RefundError)
    expect(() => refundAmountFor(itemB({ refundedQty: 2, refundedAmount: 12_087 }), 2)).toThrow(
      RefundError,
    )
  })

  it('menolak qty nol, negatif, atau pecahan', () => {
    expect(() => refundAmountFor(itemB(), 0)).toThrow(RefundError)
    expect(() => refundAmountFor(itemB(), -1)).toThrow(RefundError)
    expect(() => refundAmountFor(itemB(), 1.5)).toThrow(RefundError)
  })

  it('item yang sudah habis di-refund tidak menyisakan apa pun', () => {
    const habis = itemB({ refundedQty: 3, refundedAmount: 18_131 })
    expect(refundableQty(habis)).toBe(0)
    expect(() => refundAmountFor(habis, 1)).toThrow(RefundError)
  })

  it('menolak item yang bukan bagian dari transaksi', () => {
    expect(() => computeRefund([itemB()], [{ transactionItemId: 'asing', qty: 1 }])).toThrow(
      RefundError,
    )
  })

  it('menolak item yang sama dua kali dalam satu refund', () => {
    expect(() =>
      computeRefund(
        [itemB()],
        [
          { transactionItemId: 'b', qty: 1 },
          { transactionItemId: 'b', qty: 1 },
        ],
      ),
    ).toThrow(RefundError)
  })

  it('menolak refund tanpa item', () => {
    expect(() => computeRefund([itemB()], [])).toThrow(RefundError)
  })
})

describe('computeRefund banyak baris', () => {
  const items: RefundableItem[] = [
    {
      transactionItemId: 'a',
      productName: 'Item A',
      unitCost: 11_000,
      qty: 2,
      lineFinal: 27_196,
      refundedQty: 0,
      refundedAmount: 0,
    },
    itemB(),
    {
      transactionItemId: 'c',
      productName: 'Item C',
      unitCost: 2_500,
      qty: 1,
      lineFinal: 3_173,
      refundedQty: 0,
      refundedAmount: 0,
    },
  ]

  it('refund penuh seluruh item == netTotal fixture §3.1 (48.500)', () => {
    const totals = computeRefund(items, refundAllRemaining(items))
    expect(totals.amount).toBe(48_500)
    expect(totals.lines.map((l) => l.amount)).toEqual([27_196, 18_131, 3_173])
  })

  it('HPP refund penuh == cogsTotal fixture (39.500)', () => {
    const totals = computeRefund(items, refundAllRemaining(items))
    expect(totals.cogsAmount).toBe(39_500)
  })

  it('refund sebagian menjumlahkan baris yang diminta saja', () => {
    const totals = computeRefund(items, [
      { transactionItemId: 'b', qty: 1 },
      { transactionItemId: 'c', qty: 1 },
    ])
    expect(totals.amount).toBe(6_043 + 3_173)
    expect(totals.cogsAmount).toBe(5_000 + 2_500)
    expect(totals.lines).toHaveLength(2)
  })
})

describe('refundAllRemaining', () => {
  it('melewati item yang sudah habis di-refund', () => {
    const items = [itemB({ refundedQty: 3, refundedAmount: 18_131 }), itemB({ transactionItemId: 'c' })]
    const out = refundAllRemaining(items)
    expect(out).toEqual([{ transactionItemId: 'c', qty: 3 }])
  })

  it('mengembalikan sisa, bukan qty asal', () => {
    const out = refundAllRemaining([itemB({ refundedQty: 1, refundedAmount: 6_043 })])
    expect(out).toEqual([{ transactionItemId: 'b', qty: 2 }])
  })
})
