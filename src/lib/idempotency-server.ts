import crypto from 'node:crypto'
import { canonicalJson } from './idempotency'

/**
 * Sidik jari isi request, hanya untuk sisi server.
 *
 * Dipisahkan dari `idempotency.ts` karena `node:crypto` tidak ada di browser:
 * layar kasir hanya butuh `canonicalJson` untuk mengetahui kapan isi keranjang
 * berubah, dan menariknya lewat modul yang mengimpor `node:crypto` akan
 * menggagalkan bundle client.
 *
 * Yang disimpan hanya hash, bukan isi keranjangnya. Kolom `idempotencyFingerprint`
 * cukup untuk MEMBANDINGKAN dua request, dan itu satu-satunya tugasnya — isi
 * transaksi yang sebenarnya sudah tersimpan lengkap di tabelnya sendiri.
 */
export function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}
