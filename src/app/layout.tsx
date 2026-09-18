import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kasir Toko',
  description: 'Sistem kasir untuk satu toko, berjalan di jaringan lokal.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Kasir Toko',
  appleWebApp: { capable: true, title: 'Kasir Toko', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Kasir memakai tablet/HP; zoom tidak dikunci supaya teks kecil tetap
  // bisa diperbesar kalau perlu.
  maximumScale: 5,
  themeColor: '#14683f',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="antialiased">{children}</body>
    </html>
  )
}
