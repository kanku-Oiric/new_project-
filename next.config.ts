import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Prisma harus tetap di luar bundle server supaya query engine-nya bisa dimuat.
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],

  // Server berjalan di LAN toko tanpa TLS; jangan pernah kirim header yang
  // memaksa HTTPS karena itu akan membuat aplikasi tidak bisa diakses sama sekali.
  poweredByHeader: false,
}

export default nextConfig
