'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { outcomeMessage, postJson } from '@/lib/api-client'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/auth/pin-constants'

export function ChangePinForm({ mustChange }: { mustChange: boolean }) {
  const router = useRouter()
  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const cocok = newPin.length >= PIN_MIN_LENGTH && newPin === confirmPin
  const ready = currentPin.length >= PIN_MIN_LENGTH && cocok && !busy

  async function submit() {
    setBusy(true)
    setError(null)
    const outcome = await postJson<{ ok: boolean }>('/api/auth/change-pin', {
      currentPin,
      newPin,
    })
    setBusy(false)

    if (outcome.kind !== 'ok') {
      setError(outcomeMessage(outcome, false))
      return
    }
    setDone(true)
    setCurrentPin('')
    setNewPin('')
    setConfirmPin('')
    router.refresh()
  }

  if (done) {
    return (
      <div className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <p className="text-sm text-kasir-accent-strong">PIN berhasil diganti.</p>
        <button
          type="button"
          onClick={() => router.replace('/kasir')}
          className="mt-3 h-12 w-full rounded-xl bg-kasir-accent text-base font-medium text-white"
        >
          Lanjut ke kasir
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <PinField label="PIN sekarang" value={currentPin} onChange={setCurrentPin} />
      <PinField label={`PIN baru (${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} angka)`} value={newPin} onChange={setNewPin} />
      <PinField label="Ulangi PIN baru" value={confirmPin} onChange={setConfirmPin} />

      {confirmPin.length > 0 && !cocok && (
        <p className="mt-2 text-sm text-kasir-danger">PIN baru dan ulangannya belum sama.</p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={!ready}
        className="mt-4 h-12 w-full rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
      >
        {busy ? 'Menyimpan…' : 'Ganti PIN'}
      </button>

      {!mustChange && (
        <button
          type="button"
          onClick={() => router.back()}
          className="mt-2 h-12 w-full rounded-xl border border-kasir-border text-base"
        >
          Kembali
        </button>
      )}
    </div>
  )
}

function PinField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs text-kasir-muted">{label}</span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        maxLength={PIN_MAX_LENGTH}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        className="w-full rounded-lg border border-kasir-border px-3 text-xl tracking-widest"
      />
    </label>
  )
}
