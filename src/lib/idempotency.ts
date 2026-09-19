import { z } from 'zod'

/**
 * Kunci sekali-pakai untuk request yang memindahkan uang.
 *
 * Masalah yang diselesaikan — "false failure" (docs/architecture.md §20):
 *
 *   kasir tekan Bayar → server commit → WiFi tersendat → response hilang
 *   → kasir menyangka gagal → tekan Bayar lagi → DUA transaksi, stok turun 2×
 *
 * Dari sisi browser, "request tidak pernah sampai" dan "sampai tapi jawabannya
 * hilang" mustahil dibedakan. Karena itu sebelumnya UI hanya bisa memperingatkan
 * kasir supaya memeriksa riwayat dulu — peringatan kepada manusia untuk masalah
 * yang sifatnya mekanis. Kunci ini membuat pengulangan aman secara mekanis:
 * request kedua dengan kunci yang sama mengembalikan transaksi yang SAMA, bukan
 * membuat yang baru.
 *
 * Dua bagian, dan keduanya perlu:
 *
 *   idempotencyKey         siapa request ini. Dijaga UNIQUE di database, jadi
 *                          dua request serentak pun hanya satu yang menang.
 *   idempotencyFingerprint isi request ini. Kunci yang sama dengan isi berbeda
 *                          adalah tanda bug, dan ditolak 409 — TIDAK dijawab
 *                          dengan transaksi lain. Menjawabnya berarti kasir
 *                          menerima struk untuk penjualan yang salah tanpa
 *                          pernah tahu.
 *
 * Modul ini murni dan isomorfik: tidak menyentuh database, tidak mengimpor
 * `node:crypto`, sehingga `canonicalJson` bisa dipakai browser untuk menentukan
 * kapan kunci baru harus dibuat, dengan aturan yang sama persis seperti server.
 */

/**
 * Bentuk kunci yang diterima server: UUID, dibuat client lewat
 * `newIdempotencyKey()` di bawah.
 *
 * Dibatasi ketat supaya kolom unique tidak bisa dipakai menyelundupkan data lain,
 * dan supaya kunci tidak bisa ditebak perangkat lain di LAN.
 */
export const IdempotencyKeySchema = z.string().uuid()

/**
 * Buat kunci baru. `null` berarti browsernya tidak punya sumber acak yang layak.
 *
 * Sengaja TIDAK memakai `crypto.randomUUID()`. Fungsi itu hanya tersedia di
 * secure context, dan LAN toko berjalan di HTTP tanpa TLS (docs/architecture.md
 * §7.1) — di HP kasir yang membuka http://192.168.x.x:3000, `crypto.randomUUID`
 * memang undefined, dan memanggilnya akan menggagalkan seluruh checkout. Ini
 * bukan kehati-hatian berlebihan: localhost lolos, HP kasir tidak, jadi bug
 * seperti ini justru tidak terlihat saat diuji di laptop server.
 *
 * `crypto.getRandomValues()` tidak dibatasi secure context, jadi UUID v4-nya
 * dirakit sendiri dari situ.
 *
 * Kalau bahkan getRandomValues tidak ada, hasilnya `null` dan pemanggilnya
 * mengirim request TANPA kunci — kembali ke perilaku lama yang sudah dikenal.
 * Kunci yang bisa bertabrakan lebih berbahaya daripada tidak ada kunci: ia
 * membuat penjualan berbeda dijawab dengan struk penjualan orang lain.
 */
export function newIdempotencyKey(): string | null {
  const source = globalThis.crypto
  if (!source || typeof source.getRandomValues !== 'function') return null

  const bytes = source.getRandomValues(new Uint8Array(16))
  const at = (i: number): number => bytes[i] ?? 0
  const octets = [...bytes.keys()].map((i) => {
    if (i === 6) return (at(6) & 0x0f) | 0x40 // versi 4
    if (i === 8) return (at(8) & 0x3f) | 0x80 // varian RFC 4122
    return at(i)
  })

  const hex = octets.map((b) => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * Serialisasi deterministik: kunci objek diurutkan rekursif, sehingga dua objek
 * yang isinya sama menghasilkan string yang sama walau urutan propertinya beda.
 *
 * `JSON.stringify` biasa TIDAK cukup — ia mempertahankan urutan penyisipan, dan
 * urutan itu bergantung pada cara client membangun objeknya. Sidik jari yang
 * berubah hanya karena urutan properti akan menolak pengulangan yang sah.
 *
 * `undefined` disamakan dengan tidak ada: `{ a: 1, b: undefined }` dan `{ a: 1 }`
 * adalah request yang sama bagi server, karena keduanya di-parse Zod menjadi
 * objek yang sama.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): Json {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('angka tidak terhingga tidak bisa disidik jari')
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const out: { [key: string]: Json } = {}
    for (const [k, v] of entries) out[k] = normalize(v)
    return out
  }
  throw new Error(`tipe tidak bisa disidik jari: ${typeof value}`)
}
