import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * Folder build. Default `.next`, tapi bisa dipisahkan lewat NEXT_DIST_DIR.
   *
   * `next dev` dan `next build` sama-sama menulis ke folder ini, dan keduanya
   * menghasilkan struktur chunk yang BERBEDA. Menjalankan build saat dev server
   * hidup membuat isinya tercampur, lalu halaman gagal dengan error yang
   * menyesatkan seperti:
   *
   *     Cannot find module './vendor-chunks/zod.js'
   *
   * Itu bukan masalah dependensi — folder build-nya yang rusak. Karena
   * `tests/api-http.test.ts` menjalankan `next dev` sungguhan, ia memakai
   * NEXT_DIST_DIR sendiri supaya tidak pernah merusak dev server yang sedang
   * dipakai orang.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Prisma harus tetap di luar bundle server supaya query engine-nya bisa dimuat.
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],

  // Server berjalan di LAN toko tanpa TLS; jangan pernah kirim header yang
  // memaksa HTTPS karena itu akan membuat aplikasi tidak bisa diakses sama sekali.
  poweredByHeader: false,
}

export default nextConfig
