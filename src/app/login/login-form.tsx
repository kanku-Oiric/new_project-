'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Role } from '@/lib/enums'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/auth/pin-constants'

export interface LoginUser {
  id: string
  name: string
  role: Role
}

const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export function LoginForm({ users }: { users: LoginUser[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<LoginUser | null>(users.length === 1 ? users[0]! : null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = useCallback(() => {
    setPin('')
    setError(null)
  }, [])

  const submit = useCallback(
    async (user: LoginUser, value: string) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: user.id, pin: value }),
        })
        const data: unknown = await res.json()

        if (!res.ok) {
          const message =
            typeof data === 'object' &&
            data !== null &&
            'error' in data &&
            typeof (data as { error: { message?: unknown } }).error?.message === 'string'
              ? (data as { error: { message: string } }).error.message
              : 'Login gagal'
          setError(message)
          setPin('')
          return
        }

        router.replace('/')
        router.refresh()
      } catch {
        // Server LAN mati atau WiFi putus — kasir perlu tahu bedanya dari
        // "PIN salah", supaya tidak mencoba PIN lain sampai akunnya terkunci.
        setError('Tidak bisa menghubungi server. Periksa koneksi WiFi ke komputer kasir.')
        setPin('')
      } finally {
        setBusy(false)
      }
    },
    [router],
  )

  const press = useCallback(
    (digit: string) => {
      if (busy || !selected) return
      setError(null)
      setPin((prev) => {
        if (prev.length >= PIN_MAX_LENGTH) return prev
        const next = prev + digit
        if (next.length === PIN_MAX_LENGTH) void submit(selected, next)
        return next
      })
    },
    [busy, selected, submit],
  )

  if (!selected) {
    return (
      <div className="space-y-2">
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => {
              setSelected(u)
              reset()
            }}
            className="flex w-full items-center justify-between rounded-xl border border-kasir-border bg-kasir-surface px-4 py-3 text-left transition hover:border-kasir-accent"
          >
            <span className="text-base font-medium text-kasir-text">{u.name}</span>
            <span className="text-xs uppercase tracking-wide text-kasir-muted">
              {u.role === 'OWNER' ? 'Pemilik' : 'Kasir'}
            </span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-base font-medium text-kasir-text">{selected.name}</p>
          <p className="text-xs text-kasir-muted">
            {selected.role === 'OWNER' ? 'Pemilik' : 'Kasir'}
          </p>
        </div>
        {users.length > 1 && (
          <button
            type="button"
            onClick={() => {
              setSelected(null)
              reset()
            }}
            className="rounded-lg px-3 text-sm text-kasir-accent"
          >
            Ganti
          </button>
        )}
      </div>

      <div className="mb-4 flex justify-center gap-2" aria-label={`PIN ${pin.length} angka`}>
        {Array.from({ length: PIN_MAX_LENGTH }).map((_, i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full border ${
              i < pin.length
                ? 'border-kasir-accent bg-kasir-accent'
                : 'border-kasir-border bg-transparent'
            }`}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <div className="no-select grid grid-cols-3 gap-2">
        {KEYPAD.map((d) => (
          <KeyButton key={d} label={d} onClick={() => press(d)} disabled={busy} />
        ))}
        <KeyButton
          label="Hapus"
          small
          disabled={busy || pin.length === 0}
          onClick={() => setPin((p) => p.slice(0, -1))}
        />
        <KeyButton label="0" onClick={() => press('0')} disabled={busy} />
        <KeyButton
          label={busy ? '...' : 'Masuk'}
          small
          primary
          disabled={busy || pin.length < PIN_MIN_LENGTH}
          onClick={() => void submit(selected, pin)}
        />
      </div>
    </div>
  )
}

function KeyButton({
  label,
  onClick,
  disabled,
  primary,
  small,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  small?: boolean
}) {
  const base =
    'flex h-14 items-center justify-center rounded-xl border font-medium transition disabled:opacity-40'
  const tone = primary
    ? 'border-kasir-accent bg-kasir-accent text-white'
    : 'border-kasir-border bg-kasir-bg text-kasir-text'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${tone} ${small ? 'text-sm' : 'text-xl'}`}
    >
      {label}
    </button>
  )
}
