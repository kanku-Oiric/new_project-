/**
 * Pengganti paket `server-only` untuk vitest.
 *
 * Paket aslinya sengaja MELEMPAR saat dimuat, kecuali lewat kondisi resolusi
 * `react-server` yang dipasang bundler Next.js. Itulah gunanya: kalau sebuah
 * client component mengimpor modul server, `next build` gagal.
 *
 * Vitest tidak membangun bundle client, jadi tidak ada yang bisa dilindungi di
 * sana — yang ada hanya modul server yang tidak bisa diimpor test sama sekali.
 * Stub ini memulihkan kemampuan menguji modul itu TANPA melepas penjaganya dari
 * kode produksi: `import 'server-only'` tetap tertulis di berkas aslinya, dan
 * tetap ditegakkan saat build.
 */
export {}
