import type { MetadataRoute } from 'next'

/**
 * PWA manifest saja — TANPA service worker.
 *
 * Ini keputusan sadar (docs/architecture.md §13): cache service worker membawa
 * risiko kasir menjalankan kode lama tanpa sadar, dengan nol manfaat, karena
 * aplikasi memang tidak bisa berfungsi tanpa server LAN. Konsisten dengan
 * larangan membangun offline engine.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Kasir Toko',
    short_name: 'Kasir',
    description: 'Sistem kasir toko di jaringan lokal',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f4f5f7',
    theme_color: '#14683f',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  }
}
