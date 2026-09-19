'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatRupiah, parseRupiah } from '@/lib/money'
import { calculateCash, quickCashOptions } from '@/lib/payment'
import type { PaymentMethod } from '@/lib/enums'

/**
 * Dialog pembayaran.
 *
 * Tunai saja di Fase 2. Tombol QRIS sengaja ditampilkan dalam keadaan mati
 * dengan keterangan, bukan disembunyikan: pemilik perlu melihat bahwa jalurnya
 * ada dan belum aktif, bukan mengira sistem ini tidak mendukung QRIS.
 */
export function PaymentDialog({
  amount,
  busy,
  error,
  onCancel,
  onPay,
}: {
  amount: number
  busy: boolean
  error: string | null
  onCancel: () => void
  onPay: (method: PaymentMethod, amountTendered: number) => void
}) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const tendered = useMemo(() => {
    try {
      return parseRupiah(text) ?? 0
    } catch {
      return 0
    }
  }, [text])

  const cash = calculateCash(amount, tendered)
  const quick = useMemo(() => quickCashOptions(amount), [amount])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pembayaran"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="w-full max-w-md rounded-t-2xl bg-kasir-surface p-4 sm:rounded-2xl">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-kasir-muted">Total tagihan</h2>
          <p className="text-3xl font-semibold text-kasir-text">{formatRupiah(amount)}</p>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-kasir-muted">Uang diterima</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && cash.sufficient && !busy) onPay('CASH', tendered)
            }}
            placeholder="0"
            className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
          />
        </label>

        <div className="no-select mt-3 grid grid-cols-2 gap-2">
          {quick.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setText(String(option.value))}
              className="h-12 rounded-xl border border-kasir-border bg-kasir-bg text-sm font-medium text-kasir-text"
            >
              {option.exact ? 'Uang pas' : option.label}
            </button>
          ))}
        </div>

        <div className="my-4 flex items-baseline justify-between border-t border-kasir-border pt-3">
          {cash.sufficient ? (
            <>
              <span className="text-sm text-kasir-muted">Kembalian</span>
              <span className="text-2xl font-semibold text-kasir-accent">
                {formatRupiah(cash.changeAmount)}
              </span>
            </>
          ) : (
            <>
              <span className="text-sm text-kasir-muted">Kurang</span>
              <span className="text-2xl font-semibold text-kasir-danger">
                {formatRupiah(cash.shortfall)}
              </span>
            </>
          )}
        </div>

        {error && (
          <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-14 flex-1 rounded-xl border border-kasir-border bg-kasir-surface text-base disabled:opacity-40"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => onPay('CASH', tendered)}
            disabled={busy || !cash.sufficient}
            className="h-14 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Memproses…' : 'Selesaikan tunai'}
          </button>
        </div>

        <button
          type="button"
          disabled
          title="QRIS dikerjakan di Fase 5"
          className="mt-2 h-12 w-full rounded-xl border border-dashed border-kasir-border text-sm text-kasir-muted disabled:opacity-70"
        >
          QRIS — belum aktif (Fase 5)
        </button>
      </div>
    </div>
  )
}
