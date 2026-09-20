import { AppError } from '../errors'

/**
 * Semua nominal rupiah adalah INTEGER RUPIAH PENUH. Rupiah tidak punya sen,
 * jadi tidak ada alasan memakai pecahan. Format hanya terjadi di layer tampilan
 * lewat file ini — tidak ada tempat lain yang boleh menyusun string rupiah.
 *
 * Referensi: docs/architecture.md §4
 */

/** Batas atas kolom Int 32-bit Prisma: Rp 2.147.483.647 per kolom nominal. */
export const MAX_RUPIAH_COLUMN = 2_147_483_647

/**
 * Kesalahan aturan uang.
 *
 * Mewarisi `AppError` dengan status 400, BUKAN `Error` biasa. Semua pelanggaran
 * di sini berasal dari masukan kasir — uang kurang, diskon melebihi subtotal,
 * qty nol — jadi jawabannya harus 4xx dengan pesan yang bisa ditindaklanjuti.
 *
 * Sebelumnya ini `Error` polos, sehingga `handleApiError` menganggapnya
 * kegagalan tak terduga dan menjawab 500 "Terjadi kesalahan di server". Kasir
 * yang kurang uang kembalian jadi membaca pesan yang salah, dan sejak UI
 * membedakan 5xx dari 4xx, 500 itu bahkan menyuruhnya JANGAN mengulang
 * transaksi — nasihat yang keliru untuk masalah yang tinggal dibetulkan.
 */
export class MoneyError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION', 400, message, details)
  }
}

/**
 * Menjaga agar nilai yang masuk ke DB benar-benar integer non-negatif dan
 * tidak melewati ceiling kolom. Dipanggil di batas penulisan, bukan di setiap
 * operasi aritmatika.
 */
/**
 * Seperti `assertRupiah`, tapi untuk nilai yang BOLEH negatif: saldo provider
 * yang minus, titipan bertanda, dan selisih kas.
 *
 * Yang dijaga tetap sama — batas kolom `Int` 32-bit — hanya arahnya dua-duanya.
 * Dipisah dari `assertRupiah` dengan sengaja: melonggarkan fungsi yang sudah
 * dipakai puluhan tempat supaya menerima negatif akan mematikan penjagaan di
 * semua tempat itu sekaligus, demi dua pemanggil yang memang butuh.
 */
export function assertRupiahSigned(value: number, label = 'nominal'): number {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} harus integer rupiah penuh, dapat ${value}`)
  }
  if (value > MAX_RUPIAH_COLUMN || value < -MAX_RUPIAH_COLUMN) {
    throw new MoneyError(
      `${label} melewati batas kolom (±${MAX_RUPIAH_COLUMN}), dapat ${value}. ` +
        'Periksa jumlah nolnya.',
    )
  }
  return value
}

export function assertRupiah(value: number, label = 'nominal'): number {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} harus integer rupiah penuh, dapat ${value}`)
  }
  if (value < 0) {
    throw new MoneyError(`${label} tidak boleh negatif, dapat ${value}`)
  }
  if (value > MAX_RUPIAH_COLUMN) {
    throw new MoneyError(`${label} melewati batas kolom (${MAX_RUPIAH_COLUMN}), dapat ${value}`)
  }
  return value
}

/**
 * Agregat laporan dihitung sebagai JS number (aman sampai 2^53) dan TIDAK
 * pernah disimpan sebagai kolom Int, jadi ceiling-nya berbeda dari assertRupiah.
 */
export function assertSafeTotal(value: number, label = 'total'): number {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} harus integer, dapat ${value}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} melewati Number.MAX_SAFE_INTEGER, dapat ${value}`)
  }
  return value
}

export interface FormatRupiahOptions {
  /** Tanpa awalan "Rp ". Untuk kolom tabel yang sudah punya header satuan. */
  bare?: boolean
}

/**
 * formatRupiah(15000)              → "Rp 15.000"
 * formatRupiah(15000, {bare:true}) → "15.000"
 * formatRupiah(-5000)              → "−Rp 5.000"   (selisih kas boleh negatif)
 *
 * Memakai pemisah ribuan titik sesuai konvensi Indonesia. Tidak memakai
 * Intl.NumberFormat karena outputnya bergantung pada locale sistem — di laptop
 * toko yang locale-nya en-US, Intl akan menghasilkan "15,000" dengan koma.
 */
export function formatRupiah(value: number, options: FormatRupiahOptions = {}): string {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`tidak bisa memformat nilai non-finite: ${value}`)
  }
  const negative = value < 0
  const digits = Math.abs(Math.trunc(value)).toString()

  let grouped = ''
  for (let i = 0; i < digits.length; i++) {
    const fromRight = digits.length - i
    grouped += digits[i]
    if (fromRight > 1 && fromRight % 3 === 1) grouped += '.'
  }

  const body = options.bare ? grouped : `Rp ${grouped}`
  // U+2212 MINUS SIGN, bukan hyphen — lebih jelas terbaca di struk dan laporan.
  return negative ? `−${body}` : body
}

/**
 * parseRupiah("Rp 15.000")  → 15000
 * parseRupiah("15000")      → 15000
 * parseRupiah("")           → null
 *
 * Menerima input kasir yang mengetik dengan atau tanpa pemisah. Mengembalikan
 * null untuk input kosong supaya caller bisa membedakan "belum diisi" dari nol,
 * dan melempar untuk input yang jelas bukan angka — tidak pernah mengembalikan
 * 0 secara diam-diam, karena 0 yang salah pada nominal uang itu mahal.
 */
export function parseRupiah(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  const cleaned = trimmed
    .replace(/^Rp\s*/i, '')
    .replace(/[.\s ]/g, '')
    .replace(/,/g, '')

  if (!/^\d+$/.test(cleaned)) {
    throw new MoneyError(`bukan nominal rupiah yang valid: "${input}"`)
  }

  const value = Number(cleaned)
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`nominal terlalu besar: "${input}"`)
  }
  return value
}

/**
 * Pembulatan ke rupiah penuh, half-up. Dipakai SEKALI saat kasir memasukkan
 * diskon persen; hasilnya yang disimpan, bukan persennya.
 *
 * Math.round membulatkan .5 menjauhi nol untuk positif (half-up) tapi juga
 * untuk negatif (−2.5 → −2, bukan −3). Karena diskon selalu non-negatif,
 * perilaku itu tidak pernah tersentuh — tapi fungsi ini tetap eksplisit
 * menolak nilai negatif supaya asumsinya tidak diam-diam dilanggar nanti.
 */
export function roundRupiah(value: number): number {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`tidak bisa membulatkan nilai non-finite: ${value}`)
  }
  if (value < 0) {
    throw new MoneyError(`roundRupiah hanya untuk nilai non-negatif, dapat ${value}`)
  }
  return Math.round(value)
}

/**
 * Diskon persen → rupiah integer. Persen boleh desimal (mis. 2,5%).
 * Hasil dibatasi maksimal sebesar base, supaya diskon tidak pernah melebihi
 * nilai barangnya dan membuat total negatif.
 */
export function percentToRupiah(base: number, percent: number): number {
  assertRupiah(base, 'base diskon')
  if (!Number.isFinite(percent) || percent < 0) {
    throw new MoneyError(`persen diskon tidak valid: ${percent}`)
  }
  if (percent > 100) {
    throw new MoneyError(`persen diskon tidak boleh lebih dari 100, dapat ${percent}`)
  }
  return Math.min(base, roundRupiah((base * percent) / 100))
}
