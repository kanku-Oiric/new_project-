'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function LogoutButton() {
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
      className="rounded-lg border border-kasir-border bg-kasir-surface px-4 text-sm text-kasir-text disabled:opacity-50"
    >
      {busy ? '...' : 'Keluar'}
    </button>
  )
}
