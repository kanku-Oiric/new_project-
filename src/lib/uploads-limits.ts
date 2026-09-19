/**
 * Batas unggahan, dipisahkan dari `uploads.ts` karena file itu mengimpor
 * `node:fs` dan tidak boleh ikut ke bundle browser. Angka yang sama dipakai
 * halaman pengaturan (untuk memberi tahu pemilik) dan route (untuk menolak).
 */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024
