'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Keluar dan kembali ke daftar pengguna.
 *
 * Dipakai di Nav, jadi tersedia dari SEMUA halaman. Sebelumnya tombol ini hanya
 * ada di /beranda — halaman sisa Fase 1 yang tidak ditautkan dari mana pun —
 * sehingga kasir yang selesai shift tidak punya cara mengembalikan layar ke
 * rekannya tanpa mengetik alamat.
 */
export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await fetch('/api/auth/logout', { method: 'POST' })
        } finally {
          // Apa pun hasil requestnya, arahkan ke login: cookie sudah tidak
          // dipercaya lagi dari sisi pengguna, dan menahan mereka di halaman
          // ini justru membingungkan.
          router.replace('/login')
          router.refresh()
        }
      }}
      className={
        compact
          ? 'rounded-lg px-3 py-2 text-sm text-kasir-muted hover:bg-kasir-bg disabled:opacity-50'
          : 'rounded-lg border border-kasir-border bg-kasir-surface px-4 text-sm text-kasir-text disabled:opacity-50'
      }
    >
      {busy ? '…' : 'Keluar'}
    </button>
  )
}
