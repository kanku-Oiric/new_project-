import type { ServiceDirection, ServiceKind } from '../enums'

/**
 * Katalog jasa pembayaran — modul murni, tanpa DB.
 *
 * Referensi: docs/architecture.md §21
 *
 * Toko menjual jasa pembayaran, tapi sistem ini TIDAK memanggil API provider
 * mana pun. Kasir membayarnya lewat aplikasi lain (Shopee/GoPay) di HP-nya,
 * lalu mencatatnya di sini. Jadi yang ada di berkas ini bukan integrasi,
 * melainkan daftar jenis jasa beserta bentuk formulirnya.
 *
 * Daftarnya sengaja KODE, bukan tabel yang bisa di-CRUD pemilik. Menambah jenis
 * jasa bukan pekerjaan harian toko, dan tiap jenis punya arah uang serta bentuk
 * form yang berbeda — dua hal yang tidak bisa diisi lewat layar pengaturan
 * tanpa membuat pemilik memilih sesuatu yang tidak ia pahami. Yang BISA diatur
 * pemilik adalah biaya admin defaultnya (setting `serviceFeeDefaults`) dan
 * provider mana yang aktif.
 */

export interface ServiceKindSpec {
  kind: ServiceKind
  label: string
  /** Kalimat pendek di bawah tombol, supaya kasir baru tidak salah pilih. */
  hint: string
  direction: ServiceDirection
  /** Nominal cepat di modal. Kosong berarti nominalnya selalu diketik. */
  quickAmounts: number[]
  /** Label nomor tujuan yang diminta dari pelanggan; null = tidak ada. */
  refLabel: string | null
  /** Biaya admin bawaan, bisa ditimpa setting dan bisa diubah kasir per transaksi. */
  defaultFee: number
}

/**
 * Lima jasa pertama bergerak PROVIDER_OUT: pelanggan menyerahkan uang, saldo
 * provider berkurang. Tarik tunai bergerak sebaliknya — dan perbedaan itu yang
 * membuatnya tidak boleh dicampur dengan penjualan lain (lihat
 * `src/lib/cart/services.ts`).
 */
export const SERVICE_CATALOG: readonly ServiceKindSpec[] = [
  {
    kind: 'TOKEN_LISTRIK',
    label: 'Token Listrik',
    hint: 'Listrik prabayar',
    direction: 'PROVIDER_OUT',
    quickAmounts: [20_000, 50_000, 100_000, 200_000],
    refLabel: 'Nomor meter / ID pelanggan',
    defaultFee: 2_500,
  },
  {
    kind: 'PLN_PASCABAYAR',
    label: 'PLN Pascabayar',
    hint: 'Tagihan listrik bulanan',
    direction: 'PROVIDER_OUT',
    quickAmounts: [],
    refLabel: 'ID pelanggan',
    defaultFee: 3_000,
  },
  {
    kind: 'PDAM',
    label: 'PDAM',
    hint: 'Tagihan air',
    direction: 'PROVIDER_OUT',
    quickAmounts: [],
    refLabel: 'Nomor pelanggan',
    defaultFee: 3_000,
  },
  {
    kind: 'EWALLET_TOPUP',
    label: 'Top-up E-wallet',
    hint: 'GoPay, OVO, Dana, ShopeePay',
    direction: 'PROVIDER_OUT',
    quickAmounts: [25_000, 50_000, 100_000, 200_000],
    refLabel: 'Nomor HP tujuan',
    defaultFee: 2_000,
  },
  {
    kind: 'TRANSFER_BANK',
    label: 'Transfer Bank',
    hint: 'Kirim uang ke rekening',
    direction: 'PROVIDER_OUT',
    quickAmounts: [],
    refLabel: 'Bank & nomor rekening tujuan',
    defaultFee: 5_000,
  },
  {
    kind: 'TARIK_TUNAI',
    label: 'Tarik Tunai',
    hint: 'Pelanggan transfer, toko beri uang',
    direction: 'PROVIDER_IN',
    quickAmounts: [50_000, 100_000, 200_000, 500_000],
    refLabel: null,
    defaultFee: 5_000,
  },
]

const BY_KIND = new Map(SERVICE_CATALOG.map((s) => [s.kind, s]))

export function serviceSpec(kind: ServiceKind): ServiceKindSpec {
  const spec = BY_KIND.get(kind)
  if (!spec) throw new Error(`jenis jasa tidak dikenal: ${kind}`)
  return spec
}

export function serviceLabel(kind: ServiceKind): string {
  return serviceSpec(kind).label
}

export function serviceDirection(kind: ServiceKind): ServiceDirection {
  return serviceSpec(kind).direction
}

/**
 * Biaya admin bawaan setelah ditimpa setting pemilik.
 *
 * Nilai yang tidak masuk akal di setting (negatif, bukan bilangan bulat,
 * melebihi batas kolom Int) diabaikan dan katalog yang dipakai — sejalan dengan
 * `getSetting` yang selalu punya jaring ke nilai default, karena satu angka
 * rusak di pengaturan tidak boleh membuat layar kasir gagal dibuka.
 */
export function feeDefaults(override: Record<string, number> | null): Record<ServiceKind, number> {
  const out = {} as Record<ServiceKind, number>
  for (const spec of SERVICE_CATALOG) {
    const custom = override?.[spec.kind]
    const layak =
      typeof custom === 'number' &&
      Number.isInteger(custom) &&
      custom >= 0 &&
      custom <= 2_147_483_647
    out[spec.kind] = layak ? custom : spec.defaultFee
  }
  return out
}
