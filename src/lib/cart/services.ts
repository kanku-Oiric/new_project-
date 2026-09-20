import {
  CartError,
  computeCart,
  computeCartDisplay,
  type CartDisplayTotals,
  type CartTotals,
  type DisplayLine,
  type PricedLine,
} from './index'
import type { ServiceDirection, ServiceKind } from '../enums'
import { assertRupiah } from '../money'

/**
 * Keranjang yang berisi barang DAN jasa pembayaran — modul murni, tanpa DB.
 *
 * Referensi: docs/architecture.md §21, docs/reporting.md §9
 *
 * Satu keputusan mengunci seluruh berkas ini:
 *
 *   `netTotal` tetap berarti OMZET, bukan "yang dibayar pelanggan".
 *
 * Untuk barang, keduanya kebetulan sama. Untuk jasa, tidak: pelanggan
 * menyerahkan Rp 102.500 untuk token listrik Rp 100.000 dengan admin Rp 2.500,
 * tapi omzet toko cuma Rp 2.500. Rp 100.000 sisanya TITIPAN — uang yang mampir
 * di laci lalu diteruskan ke provider.
 *
 * Kenapa omzet yang dipertahankan artinya, bukan uangnya: `aggregateSales()`
 * menjumlahkan `netTotal` menjadi Net Sales. Kalau titipan ikut ke sana, maka
 * setiap query laporan harus INGAT menguranginya, dan omzet tercemar begitu satu
 * tempat lupa. Dengan pemisahan ini, titipan tidak punya jalur menuju Gross
 * Sales sama sekali — sifat yang sama seperti `buildAiPayload` yang secara
 * konstruksi tidak bisa menerima credential.
 *
 * Harganya, dan ini harus disebut terang: invarian lama
 * `Payment.amount === Transaction.netTotal` berakhir. Yang berlaku sekarang
 * `Payment.amount === |netTotal + passthroughTotal|`. Itu jujur — uang yang
 * bergerak memang bukan angka omzet.
 */

/** Yang boleh ditentukan client untuk satu baris jasa. */
export interface CartServiceLineInput {
  kind: ServiceKind
  providerId: string
  /** Titipan yang diteruskan ke provider. SELALU positif. */
  passthroughAmount: number
  /** Biaya admin — pendapatan toko. */
  serviceFeeAmount: number
  /**
   * Potongan yang diambil provider dari toko, kalau ada.
   *
   * Opsional dan default nol, karena belum tentu setiap toko kena potongan.
   * Kalau ada, ia masuk HPP — tanpa itu laporan akan menyebut seluruh biaya
   * admin sebagai laba, padahal sebagiannya sudah diambil provider.
   */
  providerCostAmount?: number
  /** Nomor meter / nomor HP / rekening tujuan. */
  customerRef?: string
  note?: string
}

/** Baris jasa lengkap setelah server mengisi yang tidak boleh dipercaya dari client. */
export interface PricedServiceLine extends Omit<CartServiceLineInput, 'providerCostAmount'> {
  direction: ServiceDirection
  label: string
  providerName: string
  /** Sudah pasti terisi di sisi server; nol kalau provider tidak memotong. */
  providerCostAmount: number
}

export interface CartServiceTotals {
  /** Baris barang, atau `null` kalau keranjangnya jasa saja. */
  goods: CartDisplayTotals | null
  services: PricedServiceLine[]

  /** Σ (unitPrice × qty) + Σ biaya admin. */
  grossSubtotal: number
  itemDiscountTotal: number
  transactionDiscount: number
  /** Σ biaya admin. Bagian DARI netTotal, bukan tambahan. */
  serviceFeeTotal: number
  /** OMZET: grossSubtotal − diskon. Titipan tidak ada di sini. */
  netTotal: number
  /**
   * BERTANDA. Positif: pelanggan menyerahkan titipan. Negatif: toko yang
   * menyerahkan uang tunai (tarik tunai).
   */
  passthroughTotal: number
  /** netTotal + passthroughTotal. Negatif berarti uang keluar dari laci. */
  amountDue: number
  /** `IN` = pelanggan membayar. `OUT` = toko menyerahkan uang. */
  payDirection: 'IN' | 'OUT'
  /** |amountDue| — selalu positif, inilah yang disimpan sebagai `Payment.amount`. */
  payAmount: number
}

export interface CartServerTotals extends Omit<CartServiceTotals, 'goods'> {
  /** Baris barang LENGKAP dengan HPP-nya. `null` kalau keranjangnya jasa saja. */
  goods: CartTotals | null
  /** Σ (unitCost × qty) + Σ potongan provider. Jasa punya HPP hanya kalau provider memotong. */
  cogsTotal: number
}

function validateServiceLine(line: PricedServiceLine, position: number): void {
  const label = `jasa baris ${position + 1} (${line.label})`

  assertRupiah(line.passthroughAmount, `${label}: nominal`)
  assertRupiah(line.serviceFeeAmount, `${label}: biaya admin`)
  assertRupiah(line.providerCostAmount, `${label}: potongan provider`)

  if (line.passthroughAmount < 1) {
    throw new CartError(`${label}: nominal harus minimal 1 rupiah`)
  }

  if (line.direction === 'PROVIDER_IN' && line.serviceFeeAmount >= line.passthroughAmount) {
    // Tarik tunai dengan admin ≥ nominalnya berarti pelanggan tidak menerima
    // apa pun, atau malah harus menambah uang. Itu bukan tarik tunai, dan
    // membiarkannya lewat akan menghasilkan transaksi yang arah uangnya
    // terbalik tanpa ada yang menyadarinya.
    throw new CartError(
      `${label}: biaya admin (${line.serviceFeeAmount}) harus lebih kecil daripada nominal (${line.passthroughAmount})`,
    )
  }
}

/**
 * Hitung keranjang campuran.
 *
 * `goodsLines` boleh kosong (jasa saja), `services` boleh kosong (barang saja),
 * tapi tidak keduanya.
 */
export function computeCartWithServices(
  goodsLines: DisplayLine[],
  services: PricedServiceLine[],
  transactionDiscount: number,
): CartServiceTotals {
  if (goodsLines.length === 0 && services.length === 0) {
    throw new CartError('keranjang kosong')
  }
  assertRupiah(transactionDiscount, 'diskon transaksi')

  services.forEach(validateServiceLine)

  const masuk = services.filter((s) => s.direction === 'PROVIDER_IN')
  if (masuk.length > 0) {
    // Tarik tunai berjalan ke arah berlawanan: pelanggan transfer ke rekening
    // toko, toko menyerahkan uang tunai. Mencampurnya dengan penjualan berarti
    // satu transaksi punya dua arah uang sekaligus, dan angka yang keluar dari
    // situ tidak bisa direkonsiliasi dengan laci maupun dengan mutasi rekening.
    // Tidak ada kegunaan nyatanya, jadi dilarang di sini — bukan di UI saja.
    if (masuk.length > 1 || services.length > 1 || goodsLines.length > 0) {
      throw new CartError(
        'Tarik tunai harus menjadi transaksi tersendiri — tidak bisa digabung dengan barang atau jasa lain',
      )
    }
  }

  if (transactionDiscount > 0 && goodsLines.length === 0) {
    // Menurunkan titipan mustahil: provider tetap dibayar penuh. Diskon atas
    // biaya admin lebih jujur dengan mengisi biaya adminnya lebih kecil, karena
    // angka yang tercetak di struk lalu menjadi dasar refund.
    throw new CartError('Diskon transaksi hanya berlaku untuk barang, bukan untuk jasa')
  }

  const goods = goodsLines.length > 0 ? computeCartDisplay(goodsLines, transactionDiscount) : null

  const serviceFeeTotal = services.reduce((a, s) => a + s.serviceFeeAmount, 0)
  const passthroughTotal = services.reduce(
    (a, s) => a + (s.direction === 'PROVIDER_OUT' ? s.passthroughAmount : -s.passthroughAmount),
    0,
  )

  const grossSubtotal = (goods?.grossSubtotal ?? 0) + serviceFeeTotal
  const itemDiscountTotal = goods?.itemDiscountTotal ?? 0
  const netTotal = grossSubtotal - itemDiscountTotal - transactionDiscount
  const amountDue = netTotal + passthroughTotal

  return {
    goods,
    services,
    grossSubtotal,
    itemDiscountTotal,
    transactionDiscount,
    serviceFeeTotal,
    netTotal,
    passthroughTotal,
    amountDue,
    payDirection: amountDue < 0 ? 'OUT' : 'IN',
    payAmount: Math.abs(amountDue),
  }
}

/**
 * Versi server: menambahkan HPP, yang tidak pernah dikirim ke browser.
 *
 * Perhitungan barangnya memakai `computeCart` yang sama seperti sebelum ada
 * jasa — bukan salinan. Dua implementasi untuk angka yang sama adalah cara
 * paling pasti membuat struk dan laporan berbeda setelah salah satunya diubah.
 */
export function computeCartServer(
  pricedLines: PricedLine[],
  services: PricedServiceLine[],
  transactionDiscount: number,
): CartServerTotals {
  const totals = computeCartWithServices(pricedLines, services, transactionDiscount)
  const goods = pricedLines.length > 0 ? computeCart(pricedLines, transactionDiscount) : null

  const serviceCogs = services.reduce((a, s) => a + s.providerCostAmount, 0)

  return { ...totals, goods, cogsTotal: (goods?.cogsTotal ?? 0) + serviceCogs }
}
