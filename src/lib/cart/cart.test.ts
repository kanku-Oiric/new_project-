import { describe, expect, it } from 'vitest'
import { CartError, allocateLargestRemainder, computeCart, grossProfitOf, type PricedLine } from './index'

/**
 * Fixture dari docs/reporting.md §3.1, dipakai apa adanya.
 *
 * Angka di dokumen itu bukan ilustrasi — ia adalah spesifikasi. Kalau test ini
 * gagal, yang berubah adalah perilaku uang, dan dokumennya harus ikut diperbarui
 * secara sadar, bukan diam-diam.
 */
const FIXTURE: PricedLine[] = [
  {
    productId: 'a',
    productName: 'Item A',
    sku: 'A',
    unitPrice: 15_000,
    unitCost: 11_000,
    qty: 2,
    itemDiscount: 0,
  },
  {
    productId: 'b',
    productName: 'Item B',
    sku: 'B',
    unitPrice: 7_000,
    unitCost: 5_000,
    qty: 3,
    itemDiscount: 1_000,
  },
  {
    productId: 'c',
    productName: 'Item C',
    sku: 'C',
    unitPrice: 3_500,
    unitCost: 2_500,
    qty: 1,
    itemDiscount: 0,
  },
]

describe('fixture docs/reporting.md §3.1', () => {
  const totals = computeCart(FIXTURE, 5_000)
  const [a, b, c] = totals.lines

  it('subtotal, diskon item, dan Σ lineNet sesuai dokumen', () => {
    expect(totals.grossSubtotal).toBe(54_500)
    expect(totals.itemDiscountTotal).toBe(1_000)
    expect(totals.lines.reduce((s, l) => s + l.lineNet, 0)).toBe(53_500)
  })

  it('lineGross dan lineNet per baris sesuai tabel', () => {
    expect(a?.lineGross).toBe(30_000)
    expect(a?.lineNet).toBe(30_000)
    expect(b?.lineGross).toBe(21_000)
    expect(b?.lineNet).toBe(20_000)
    expect(c?.lineGross).toBe(3_500)
    expect(c?.lineNet).toBe(3_500)
  })

  it('alokasi largest-remainder persis A=2.804 B=1.869 C=327', () => {
    // Σ floor = 4.999; satu rupiah sisa jatuh ke A karena remainder-nya
    // terbesar (0,738). Inilah satu baris yang membedakan hasil benar dari
    // hasil yang meleset satu rupiah.
    expect(a?.allocatedTxDiscount).toBe(2_804)
    expect(b?.allocatedTxDiscount).toBe(1_869)
    expect(c?.allocatedTxDiscount).toBe(327)
    expect(
      totals.lines.reduce((s, l) => s + l.allocatedTxDiscount, 0),
    ).toBe(5_000)
  })

  it('lineFinal persis 27.196 / 18.131 / 3.173', () => {
    expect(a?.lineFinal).toBe(27_196)
    expect(b?.lineFinal).toBe(18_131)
    expect(c?.lineFinal).toBe(3_173)
  })

  it('netTotal 48.500 dan Σ lineFinal cocok persis', () => {
    expect(totals.netTotal).toBe(48_500)
    expect(totals.lines.reduce((s, l) => s + l.lineFinal, 0)).toBe(48_500)
  })

  it('HPP 39.500 dan laba kotor 9.000', () => {
    expect(totals.cogsTotal).toBe(39_500)
    expect(grossProfitOf(totals)).toBe(9_000)
  })
})

describe('allocateLargestRemainder', () => {
  it('kasus dokumen', () => {
    expect(allocateLargestRemainder(5_000, [30_000, 20_000, 3_500])).toEqual([2_804, 1_869, 327])
  })

  it('total nol menghasilkan nol semua', () => {
    expect(allocateLargestRemainder(0, [100, 200])).toEqual([0, 0])
  })

  it('satu baris menerima seluruhnya', () => {
    expect(allocateLargestRemainder(5_000, [20_000])).toEqual([5_000])
  })

  it('pembagian yang habis dibagi rata', () => {
    expect(allocateLargestRemainder(3_000, [10_000, 10_000, 10_000])).toEqual([1_000, 1_000, 1_000])
  })

  it('seri remainder dipecahkan ke indeks terkecil, deterministik', () => {
    // 1 rupiah untuk dua bobot identik: harus selalu jatuh ke indeks 0.
    expect(allocateLargestRemainder(1, [100, 100])).toEqual([1, 0])
    expect(allocateLargestRemainder(1, [100, 100])).toEqual([1, 0])
    expect(allocateLargestRemainder(3, [100, 100, 100])).toEqual([1, 1, 1])
    expect(allocateLargestRemainder(2, [100, 100, 100])).toEqual([1, 1, 0])
  })

  it('bobot nol tidak pernah menerima alokasi', () => {
    // Baris yang lineNet-nya nol (diskon item 100%) tidak boleh ikut menanggung
    // diskon transaksi — kalau ikut, lineFinal-nya jadi negatif.
    const out = allocateLargestRemainder(1_000, [0, 5_000])
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(1_000)
  })

  it('menolak alokasi ketika seluruh bobot nol', () => {
    expect(() => allocateLargestRemainder(1_000, [0, 0])).toThrow(CartError)
    expect(allocateLargestRemainder(0, [0, 0])).toEqual([0, 0])
  })

  it('KONSERVASI RUPIAH: Σ alokasi == total untuk ratusan kombinasi', () => {
    // Inilah properti yang sebenarnya dijaga. Satu kombinasi yang meleset
    // berarti toko kehilangan atau menciptakan uang.
    let checked = 0
    for (let total = 0; total <= 60; total += 1) {
      for (let w1 = 0; w1 <= 40; w1 += 7) {
        for (let w2 = 0; w2 <= 40; w2 += 3) {
          for (let w3 = 0; w3 <= 40; w3 += 11) {
            const weights = [w1, w2, w3]
            const sum = w1 + w2 + w3
            if (sum === 0) continue
            if (total > sum) continue
            const out = allocateLargestRemainder(total, weights)
            expect(out.reduce((a, b) => a + b, 0)).toBe(total)
            // Tidak ada bagian yang melebihi bobotnya → lineFinal tak pernah negatif.
            out.forEach((v, i) => expect(v).toBeLessThanOrEqual(weights[i] ?? 0))
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('tepat pada nominal besar tanpa kehilangan presisi float', () => {
    // total × bobot di sini mencapai 4×10^18, jauh melewati 2^53. Dihitung
    // sebagai Number, pembagiannya kehilangan presisi dan remainder-nya jadi
    // tidak bisa dipercaya; dengan BigInt hasilnya eksak.
    //
    //   A: floor(4e18 / 3e9) = 1.333.333.333  sisa 1.000.000.000
    //   B: floor(2e18 / 3e9) =   666.666.666  sisa 2.000.000.000  ← terbesar
    //   Σ floor = 1.999.999.999, kurang 1 → jatuh ke B.
    const total = 2_000_000_000
    const weights = [2_000_000_000, 1_000_000_000]
    const out = allocateLargestRemainder(total, weights)
    expect(out.reduce((a, b) => a + b, 0)).toBe(total)
    expect(out).toEqual([1_333_333_333, 666_666_667])
  })
})

describe('computeCart — validasi', () => {
  const base: PricedLine = {
    productId: 'x',
    productName: 'Barang',
    sku: 'X',
    unitPrice: 10_000,
    unitCost: 7_000,
    qty: 1,
    itemDiscount: 0,
  }

  it('menolak keranjang kosong', () => {
    expect(() => computeCart([], 0)).toThrow(CartError)
  })

  it('menolak qty nol, negatif, atau pecahan', () => {
    expect(() => computeCart([{ ...base, qty: 0 }], 0)).toThrow(CartError)
    expect(() => computeCart([{ ...base, qty: -1 }], 0)).toThrow(CartError)
    expect(() => computeCart([{ ...base, qty: 1.5 }], 0)).toThrow(CartError)
  })

  it('menolak diskon item melebihi subtotal baris', () => {
    expect(() => computeCart([{ ...base, itemDiscount: 10_001 }], 0)).toThrow(CartError)
    // Tepat sama dengan subtotal masih boleh — barang gratis itu sah.
    const totals = computeCart([{ ...base, itemDiscount: 10_000 }], 0)
    expect(totals.netTotal).toBe(0)
  })

  it('menolak diskon transaksi melebihi total setelah diskon item', () => {
    expect(() => computeCart([base], 10_001)).toThrow(CartError)
    expect(computeCart([base], 10_000).netTotal).toBe(0)
  })

  it('menolak harga atau diskon negatif', () => {
    expect(() => computeCart([{ ...base, unitPrice: -1 }], 0)).toThrow()
    expect(() => computeCart([{ ...base, itemDiscount: -1 }], 0)).toThrow()
  })

  it('seluruh baris digratiskan lewat diskon item, diskon transaksi harus nol', () => {
    const lines = [{ ...base, itemDiscount: 10_000 }]
    expect(computeCart(lines, 0).netTotal).toBe(0)
    expect(() => computeCart(lines, 1)).toThrow(CartError)
  })
})

describe('computeCart — kasus sehari-hari toko', () => {
  it('tanpa diskon sama sekali', () => {
    const totals = computeCart(
      [
        { productId: '1', productName: 'Aqua', sku: 'A1', unitPrice: 4_000, unitCost: 2_800, qty: 3, itemDiscount: 0 },
        { productId: '2', productName: 'Indomie', sku: 'A2', unitPrice: 3_500, unitCost: 2_700, qty: 5, itemDiscount: 0 },
      ],
      0,
    )
    expect(totals.grossSubtotal).toBe(29_500)
    expect(totals.netTotal).toBe(29_500)
    expect(totals.cogsTotal).toBe(21_900)
    expect(grossProfitOf(totals)).toBe(7_600)
    expect(totals.lines.every((l) => l.allocatedTxDiscount === 0)).toBe(true)
  })

  it('banyak baris dengan diskon transaksi ganjil tetap konservatif', () => {
    const lines: PricedLine[] = Array.from({ length: 17 }, (_, i) => ({
      productId: String(i),
      productName: `P${i}`,
      sku: `S${i}`,
      unitPrice: 1_100 + i * 37,
      unitCost: 800 + i * 20,
      qty: (i % 4) + 1,
      itemDiscount: i % 3 === 0 ? 100 : 0,
    }))
    const totals = computeCart(lines, 7_777)
    expect(totals.lines.reduce((s, l) => s + l.allocatedTxDiscount, 0)).toBe(7_777)
    expect(totals.lines.reduce((s, l) => s + l.lineFinal, 0)).toBe(totals.netTotal)
    expect(totals.lines.every((l) => l.lineFinal >= 0)).toBe(true)
  })
})
