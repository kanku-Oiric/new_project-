'use client'

import { useEffect } from 'react'

/**
 * Buka dialog cetak browser saat halaman dibuka dengan ?print=1.
 *
 * Dipisah sebagai client component sekecil ini supaya halaman struk tetap
 * server component — isinya murni data, tidak ada alasan mengirim seluruhnya
 * ke browser hanya demi satu panggilan window.print().
 */
export function AutoPrint() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 300)
    return () => clearTimeout(t)
  }, [])
  return null
}
