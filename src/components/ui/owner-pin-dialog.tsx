'use client'

import { useEffect, useRef, useState } from 'react'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/auth/pin-constants'

/**
 * Dialog PIN pemilik untuk aksi sensitif (void, refund, hapus pengeluaran).
 *
 * PIN diminta ULANG setiap kali, tidak mengandalkan session: kasir yang
 * meninggalkan device dalam keadaan login tidak boleh otomatis memberi akses
 * pemilik. Verifikasinya tetap di server — dialog ini hanya mengumpulkan input.
 */
export function OwnerPinDialog({
  title,
  description,
  warning,
  confirmLabel,
  busy,
  error,
  reasonLabel,
  onCancel,
  onConfirm,
}: {
  title: string
  description?: string
  /** Peringatan yang harus dibaca sebelum melanjutkan, mis. dana QRIS. */
  warning?: string | null
  confirmLabel: string
  busy: boolean
  error: string | null
  reasonLabel: string
  onCancel: () => void
  onConfirm: (ownerPin: string, reason: string) => void
}) {
  const [pin, setPin] = useState('')
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const reasonRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    reasonRef.current?.focus()
  }, [])

  const ready =
    pin.length >= PIN_MIN_LENGTH && reason.trim().length >= 3 && (!warning || acknowledged)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
    >
      <div className="w-full max-w-md rounded-t-2xl bg-kasir-surface p-4 sm:rounded-2xl">
        <h2 className="text-base font-semibold text-kasir-text">{title}</h2>
        {description && <p className="mt-1 text-sm text-kasir-muted">{description}</p>}

        {warning && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm text-kasir-warning">⚠️ {warning}</p>
            <label className="mt-2 flex items-start gap-2 text-sm text-kasir-text">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-1 h-4 w-4 min-h-0"
              />
              <span>Saya mengerti, pengembalian uang akan diurus manual oleh pemilik.</span>
            </label>
          </div>
        )}

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">{reasonLabel}</span>
          <input
            ref={reasonRef}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">PIN pemilik</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            maxLength={PIN_MAX_LENGTH}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready && !busy) onConfirm(pin, reason.trim())
            }}
            className="w-full rounded-lg border border-kasir-border px-3 text-xl tracking-widest"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-12 flex-1 rounded-xl border border-kasir-border text-base disabled:opacity-40"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => onConfirm(pin, reason.trim())}
            disabled={busy || !ready}
            className="h-12 flex-[2] rounded-xl bg-kasir-danger text-base font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Memproses…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
