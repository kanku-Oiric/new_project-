import { describe, expect, it } from 'vitest'
import { computeCartServer, computeCartWithServices, type PricedServiceLine } from './services'
import type { DisplayLine } from './index'
import { SERVICE_CATALOG, feeDefaults, serviceDirection, serviceSpec } from '../service/catalog'

/**
 * Yang diuji di sini adalah satu pernyataan yang kalau salah akan merusak
 * seluruh laporan toko:
 *
 *   TITIPAN TIDAK PERNAH MASUK OMZET.
 *
 * Token listrik Rp 100.000 dengan admin Rp 2.500 adalah omzet Rp 2.500 —
 * bukan Rp 102.500, dan bukan pula Rp 100.000. Kalau angka itu salah, pemilik
 * akan mengira tokonya beromzet puluhan juta sebulan dari uang yang sebenarnya
 * cuma numpang lewat, lalu mengambil keputusan berdasarkan angka itu.
 */

const BARANG: DisplayLine = {
  productId: 'p1',
  productName: 'Indomie Goreng',
  sku: 'MIE-001',
  unitPrice: 3_500,
  qty: 2,
  itemDiscount: 0,
}

function jasa(over: Partial<PricedServiceLine> = {}): PricedServiceLine {
  return {
    kind: 'TOKEN_LISTRIK',
    direction: 'PROVIDER_OUT',
    label: 'Token Listrik',
    providerId: 'prov-1',
    providerName: 'Shopee',
    passthroughAmount: 100_000,
    serviceFeeAmount: 2_500,
    providerCostAmount: 0,
    ...over,
  }
}

describe('keranjang dengan jasa pembayaran', () => {
  it('titipan tidak masuk omzet, hanya biaya admin yang masuk', () => {
    const t = computeCartWithServices([], [jasa()], 0)

    expect(t.netTotal).toBe(2_500) // OMZET
    expect(t.serviceFeeTotal).toBe(2_500)
    expect(t.passthroughTotal).toBe(100_000) // TITIPAN, terpisah
    expect(t.amountDue).toBe(102_500) // yang diserahkan pelanggan
    expect(t.payDirection).toBe('IN')
    expect(t.payAmount).toBe(102_500)
  })

  it('barang dan jasa dalam satu pembayaran', () => {
    // Inti permintaannya: pelanggan beli mie lalu sekalian beli token, satu kali bayar.
    const t = computeCartWithServices([BARANG], [jasa()], 0)

    expect(t.grossSubtotal).toBe(7_000 + 2_500)
    expect(t.netTotal).toBe(9_500) // omzet: mie 7.000 + admin 2.500
    expect(t.passthroughTotal).toBe(100_000)
    expect(t.amountDue).toBe(109_500)
  })

  it('beberapa jasa sekaligus dijumlahkan terpisah', () => {
    const t = computeCartWithServices(
      [],
      [
        jasa(),
        jasa({ kind: 'EWALLET_TOPUP', label: 'Top-up E-wallet', passthroughAmount: 50_000, serviceFeeAmount: 2_000 }),
      ],
      0,
    )

    expect(t.netTotal).toBe(4_500)
    expect(t.passthroughTotal).toBe(150_000)
    expect(t.amountDue).toBe(154_500)
  })

  it('tarik tunai membalik arah uang: laci berkurang, omzet tetap naik', () => {
    const t = computeCartWithServices(
      [],
      [
        jasa({
          kind: 'TARIK_TUNAI',
          label: 'Tarik Tunai',
          direction: 'PROVIDER_IN',
          passthroughAmount: 500_000,
          serviceFeeAmount: 5_000,
        }),
      ],
      0,
    )

    expect(t.netTotal).toBe(5_000) // omzet toko tetap positif
    expect(t.passthroughTotal).toBe(-500_000) // saldo provider yang bertambah
    expect(t.amountDue).toBe(-495_000)
    expect(t.payDirection).toBe('OUT') // toko yang menyerahkan uang
    expect(t.payAmount).toBe(495_000) // selalu positif — lihat komentar di enums.ts
  })

  it('tarik tunai TIDAK boleh dicampur dengan barang', () => {
    expect(() =>
      computeCartWithServices([BARANG], [jasa({ direction: 'PROVIDER_IN', kind: 'TARIK_TUNAI' })], 0),
    ).toThrow(/transaksi tersendiri/)
  })

  it('tarik tunai TIDAK boleh dicampur dengan jasa lain', () => {
    expect(() =>
      computeCartWithServices(
        [],
        [jasa(), jasa({ direction: 'PROVIDER_IN', kind: 'TARIK_TUNAI', passthroughAmount: 200_000 })],
        0,
      ),
    ).toThrow(/transaksi tersendiri/)
  })

  it('tarik tunai dengan admin ≥ nominal ditolak', () => {
    // Kalau lolos, pelanggan transfer 50.000 lalu menerima nol rupiah — dan
    // arah uang transaksinya diam-diam terbalik.
    expect(() =>
      computeCartWithServices(
        [],
        [
          jasa({
            direction: 'PROVIDER_IN',
            kind: 'TARIK_TUNAI',
            passthroughAmount: 50_000,
            serviceFeeAmount: 50_000,
          }),
        ],
        0,
      ),
    ).toThrow(/lebih kecil daripada nominal/)
  })

  it('diskon transaksi hanya berlaku atas barang', () => {
    const t = computeCartWithServices([BARANG], [jasa()], 1_000)

    // Diskon memotong barang, bukan admin dan bukan titipan.
    expect(t.netTotal).toBe(9_500 - 1_000)
    expect(t.goods?.lines[0]?.allocatedTxDiscount).toBe(1_000)
    expect(t.passthroughTotal).toBe(100_000)
    expect(t.amountDue).toBe(108_500)
  })

  it('keranjang jasa saja tidak boleh diberi diskon transaksi', () => {
    expect(() => computeCartWithServices([], [jasa()], 500)).toThrow(/hanya berlaku untuk barang/)
  })

  it('keranjang benar-benar kosong ditolak', () => {
    expect(() => computeCartWithServices([], [], 0)).toThrow(/kosong/)
  })

  it('nominal titipan nol ditolak', () => {
    expect(() => computeCartWithServices([], [jasa({ passthroughAmount: 0 })], 0)).toThrow(
      /minimal 1 rupiah/,
    )
  })

  it('nominal negatif ditolak sebelum sempat menyentuh apa pun', () => {
    expect(() => computeCartWithServices([], [jasa({ passthroughAmount: -5_000 })], 0)).toThrow()
  })

  it('biaya admin nol diperbolehkan — toko memang boleh tidak memungut', () => {
    const t = computeCartWithServices([], [jasa({ serviceFeeAmount: 0 })], 0)
    expect(t.netTotal).toBe(0)
    expect(t.amountDue).toBe(100_000)
  })
})

describe('HPP jasa', () => {
  it('tanpa potongan provider, biaya admin seluruhnya jadi laba kotor', () => {
    const t = computeCartServer([], [jasa()], 0)
    expect(t.cogsTotal).toBe(0)
    expect(t.netTotal - t.cogsTotal).toBe(2_500)
  })

  it('potongan provider masuk HPP, jadi laba kotor jasa bukan biaya adminnya', () => {
    // Kalau Shopee memotong Rp 1.000 per token, laba toko 1.500 — bukan 2.500.
    // Tanpa kolom ini, laporan akan melebih-lebihkan laba setiap bulan.
    const t = computeCartServer([], [jasa({ providerCostAmount: 1_000 })], 0)
    expect(t.cogsTotal).toBe(1_000)
    expect(t.netTotal - t.cogsTotal).toBe(1_500)
  })

  it('HPP barang dan potongan provider dijumlahkan', () => {
    const t = computeCartServer(
      [{ ...BARANG, unitCost: 2_800 }],
      [jasa({ providerCostAmount: 1_000 })],
      0,
    )
    expect(t.cogsTotal).toBe(2_800 * 2 + 1_000)
    // Baris barangnya tetap membawa HPP per baris, untuk disalin ke transaction_items.
    expect(t.goods?.lines[0]?.lineCogs).toBe(5_600)
  })
})

describe('katalog jasa', () => {
  it('enam jenis, dan hanya tarik tunai yang arahnya masuk', () => {
    expect(SERVICE_CATALOG).toHaveLength(6)
    const masuk = SERVICE_CATALOG.filter((s) => s.direction === 'PROVIDER_IN')
    expect(masuk.map((s) => s.kind)).toEqual(['TARIK_TUNAI'])
  })

  it('setiap jenis punya label dan arah', () => {
    for (const spec of SERVICE_CATALOG) {
      expect(spec.label.trim()).not.toBe('')
      expect(serviceDirection(spec.kind)).toBe(spec.direction)
      expect(serviceSpec(spec.kind)).toBe(spec)
    }
  })

  it('setting biaya admin menimpa katalog', () => {
    const fee = feeDefaults({ TOKEN_LISTRIK: 3_000 })
    expect(fee.TOKEN_LISTRIK).toBe(3_000)
    expect(fee.PDAM).toBe(serviceSpec('PDAM').defaultFee)
  })

  it('setting yang tidak masuk akal diabaikan, bukan membuat layar kasir gagal', () => {
    // Satu angka rusak di pengaturan tidak boleh menjatuhkan halaman — pelajaran
    // dari BUG-03 (getSetting yang jaring defaultnya tidak pernah terpasang).
    const fee = feeDefaults({
      TOKEN_LISTRIK: -1,
      PDAM: 1.5,
      EWALLET_TOPUP: Number.NaN,
      TRANSFER_BANK: 9_999_999_999,
    } as unknown as Record<string, number>)

    expect(fee.TOKEN_LISTRIK).toBe(serviceSpec('TOKEN_LISTRIK').defaultFee)
    expect(fee.PDAM).toBe(serviceSpec('PDAM').defaultFee)
    expect(fee.EWALLET_TOPUP).toBe(serviceSpec('EWALLET_TOPUP').defaultFee)
    expect(fee.TRANSFER_BANK).toBe(serviceSpec('TRANSFER_BANK').defaultFee)
  })

  it('feeDefaults tanpa setting sama sekali tetap lengkap', () => {
    const fee = feeDefaults(null)
    for (const spec of SERVICE_CATALOG) expect(fee[spec.kind]).toBe(spec.defaultFee)
  })
})
