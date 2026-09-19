'use client'

import { useRef } from 'react'
import { canonicalJson, newIdempotencyKey } from './idempotency'

/**
 * Kunci sekali-pakai yang bertahan selama isinya belum berubah.
 *
 * Aturannya satu baris: **kunci yang sama selama isi request sama, kunci baru
 * begitu isinya berubah.** Dua sifat yang sama-sama dibutuhkan:
 *
 *  - Tekan Bayar lagi karena response hilang → kunci sama → server mengembalikan
 *    transaksi yang sama, bukan membuat yang kedua.
 *  - Kasir menambah satu barang lalu menekan Bayar → isi berbeda → kunci baru →
 *    penjualan baru, sebagaimana yang ia maksud.
 *
 * Kalau kunci tidak diganti saat isi berubah, yang terjadi jauh lebih buruk
 * daripada duplikat: server menjawab dengan transaksi LAMA, dan kasir menerima
 * struk penjualan yang salah tanpa pernah tahu. (Server tetap menolak keadaan itu
 * lewat sidik jari — ini lapisan pertama, bukan satu-satunya.)
 *
 * `null` berarti browsernya tidak punya sumber acak yang layak; pemanggil harus
 * mengirim request tanpa kunci, bukan memaksakan kunci yang bisa bertabrakan.
 */
export function useIdempotencyKey(): (payload: unknown) => string | null {
  const key = useRef<string | null>(null)
  const signature = useRef<string | null>(null)

  return (payload: unknown) => {
    const next = canonicalJson(payload)
    if (signature.current !== next || key.current === null) {
      signature.current = next
      key.current = newIdempotencyKey()
    }
    return key.current
  }
}
