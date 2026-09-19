/**
 * CSV — fungsi murni, tanpa database.
 *
 * Aturan pengutipan mengikuti RFC 4180: bungkus dengan kutip ganda kalau isinya
 * memuat pemisah, kutip, atau baris baru, dan kutip di dalam digandakan.
 *
 * Satu keputusan yang perlu disebut: nilai yang dimulai dengan `=`, `+`, `-`,
 * atau `@` diberi awalan kutip tunggal. Tanpa itu, nama produk seperti
 * `=CMD|...` akan dieksekusi Excel sebagai formula saat berkasnya dibuka —
 * jalur serangan yang dikenal sebagai CSV injection. Data toko ini diisi
 * manusia, dan berkasnya dibuka di komputer orang lain (misalnya akuntan).
 */

const NEEDS_QUOTE = /[",\r\n]/
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''

  let text: string
  if (value instanceof Date) {
    text = value.toISOString()
  } else if (typeof value === 'bigint') {
    text = value.toString()
  } else if (typeof value === 'object') {
    text = JSON.stringify(value)
  } else {
    text = String(value)
  }

  // Penetralan formula HANYA untuk nilai yang aslinya string.
  //
  // Angka negatif tidak boleh ikut. Kolom `difference`, `qtyChange`, dan
  // `stockAfter` memang sering bernilai minus — stok minus adalah keadaan yang
  // sengaja diizinkan sistem ini. Kalau -5 ditulis sebagai `'-5`, Excel
  // membacanya sebagai teks, dan pemilik tidak bisa menjumlahkan kolom selisih
  // kasnya. Ditemukan oleh test, bukan oleh pemilik.
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`

  if (NEEDS_QUOTE.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',')
}

/**
 * Susun CSV dari daftar objek.
 *
 * Kolomnya WAJIB disebut eksplisit oleh pemanggil, bukan diambil dari kunci baris
 * pertama. Dua alasan: urutan kolom jadi stabil antar-export, dan kolom baru di
 * schema tidak ikut terbawa diam-diam — termasuk kolom yang memang tidak boleh
 * ikut, seperti `pinHash`.
 */
export function toCsv<T extends Record<string, unknown>>(
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
): string {
  const lines = [csvRow([...columns])]
  for (const row of rows) {
    lines.push(csvRow(columns.map((c) => row[c])))
  }
  // CRLF: Excel di Windows adalah pembaca utamanya, dan RFC 4180 memang CRLF.
  return `${lines.join('\r\n')}\r\n`
}

/**
 * BOM UTF-8.
 *
 * Tanpa ini, Excel di Windows membaca "Ayam Goreng Pedas" dengan benar tapi
 * merusak karakter non-ASCII pada nama produk atau catatan. Tiga byte yang
 * menghindari laporan "hurufnya jadi aneh".
 */
export const UTF8_BOM = '﻿'
