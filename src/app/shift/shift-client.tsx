'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getJson, outcomeMessage, postJson } from '@/lib/api-client'
import { formatRupiah, parseRupiah } from '@/lib/money'
import type { ShiftSummary } from '@/lib/shift'

export interface OpenShiftInfo {
  id: string
  openedAt: string
  openingCash: number
}

interface CloseResult {
  summary: ShiftSummary
  cancelledPending: number
  backupFile: string | null
}

export function ShiftClient({
  initialShift,
  initialSummary,
}: {
  initialShift: OpenShiftInfo | null
  initialSummary: ShiftSummary | null
}) {
  const router = useRouter()
  const [shift, setShift] = useState(initialShift)
  const [summary, setSummary] = useState(initialSummary)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState<CloseResult | null>(null)

  const refresh = useCallback(async () => {
    const outcome = await getJson<{ shift: OpenShiftInfo | null; summary: ShiftSummary | null }>(
      '/api/shifts/current',
    )
    if (outcome.kind === 'ok') {
      setShift(outcome.data.shift)
      setSummary(outcome.data.summary)
    }
  }, [])

  if (closed) {
    return <ClosedReport result={closed} onDone={() => { setClosed(null); void refresh(); router.refresh() }} />
  }

  if (!shift || !summary) {
    return <OpenShiftForm busy={busy} error={error} setBusy={setBusy} setError={setError} onOpened={async () => { await refresh(); router.refresh() }} />
  }

  return (
    <CloseShiftForm
      shift={shift}
      summary={summary}
      busy={busy}
      error={error}
      setBusy={setBusy}
      setError={setError}
      onRefresh={refresh}
      onClosed={setClosed}
    />
  )
}

function OpenShiftForm({
  busy,
  error,
  setBusy,
  setError,
  onOpened,
}: {
  busy: boolean
  error: string | null
  setBusy: (v: boolean) => void
  setError: (v: string | null) => void
  onOpened: () => Promise<void>
}) {
  const [text, setText] = useState('')

  const openingCash = (() => {
    try {
      return parseRupiah(text) ?? 0
    } catch {
      return 0
    }
  })()

  return (
    <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <h2 className="text-base font-semibold text-kasir-text">Buka shift</h2>
      <p className="mt-1 text-sm text-kasir-muted">
        Hitung uang di laci sebelum mulai. Angka ini jadi dasar rekonsiliasi saat tutup shift, jadi
        isi apa adanya — termasuk kalau nol.
      </p>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs text-kasir-muted">Kas awal</span>
        <input
          type="text"
          inputMode="numeric"
          value={text}
          placeholder="0"
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
        />
      </label>
      <p className="mt-1 text-sm text-kasir-muted">{formatRupiah(openingCash)}</p>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          const outcome = await postJson<{ shiftId: string }>('/api/shifts/open', { openingCash })
          setBusy(false)
          if (outcome.kind !== 'ok') {
            setError(outcomeMessage(outcome, true))
            return
          }
          await onOpened()
        }}
        className="mt-4 h-14 w-full rounded-xl bg-kasir-accent text-lg font-medium text-white disabled:opacity-40"
      >
        {busy ? 'Membuka…' : 'Buka shift'}
      </button>
    </section>
  )
}

function CloseShiftForm({
  shift,
  summary,
  busy,
  error,
  setBusy,
  setError,
  onRefresh,
  onClosed,
}: {
  shift: OpenShiftInfo
  summary: ShiftSummary
  busy: boolean
  error: string | null
  setBusy: (v: boolean) => void
  setError: (v: string | null) => void
  onRefresh: () => Promise<void>
  onClosed: (r: CloseResult) => void
}) {
  const [text, setText] = useState('')
  const [notes, setNotes] = useState('')

  const counted = (() => {
    try {
      return parseRupiah(text)
    } catch {
      return null
    }
  })()

  const difference = counted === null ? null : counted - summary.expectedCash

  return (
    <>
      <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-kasir-text">Shift berjalan</h2>
            <p className="text-sm text-kasir-muted">
              Dibuka {new Date(shift.openedAt).toLocaleString('id-ID')}
            </p>
          </div>
          <button type="button" onClick={() => void onRefresh()} className="px-3 text-sm text-kasir-accent">
            Muat ulang
          </button>
        </div>

        <dl className="mt-4 space-y-1 text-sm">
          <Row label="Kas awal" value={formatRupiah(summary.openingCash)} />
          <Row label="Penjualan tunai" value={formatRupiah(summary.cashSales)} />
          <Row label="Refund tunai" value={`−${formatRupiah(summary.cashRefunds, { bare: true })}`} />
          <Row label="Pengeluaran kas" value={`−${formatRupiah(summary.cashExpenses, { bare: true })}`} />
        </dl>

        <div className="mt-3 flex items-baseline justify-between border-t border-kasir-border pt-3">
          <span className="text-sm text-kasir-muted">Uang seharusnya di laci</span>
          <span className="text-xl font-semibold text-kasir-text">
            {formatRupiah(summary.expectedCash)}
          </span>
        </div>

        <p className="mt-3 text-xs text-kasir-muted">
          {summary.transactionCount} transaksi selesai. Penjualan non-tunai{' '}
          {formatRupiah(summary.nonCashSales)} masuk rekening, bukan laci.
        </p>
      </section>

      <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <h2 className="text-base font-semibold text-kasir-text">Tutup shift</h2>

        {summary.pendingCount > 0 && (
          <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-kasir-warning">
            {summary.pendingCount} transaksi QRIS belum selesai akan dibatalkan saat shift ditutup.
            Penutupan tidak terhalang oleh ini.
          </p>
        )}

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Uang yang dihitung di laci</span>
          <input
            type="text"
            inputMode="numeric"
            value={text}
            placeholder="0"
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
          />
        </label>

        {difference !== null && (
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-sm text-kasir-muted">Selisih</span>
            <span
              className={`text-xl font-semibold ${
                difference === 0
                  ? 'text-kasir-accent'
                  : difference < 0
                    ? 'text-kasir-danger'
                    : 'text-kasir-warning'
              }`}
            >
              {difference > 0 ? '+' : ''}
              {formatRupiah(difference)}
            </span>
          </div>
        )}

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Catatan (opsional)</span>
          <input
            type="text"
            value={notes}
            maxLength={500}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
          />
        </label>

        <p className="mt-3 text-xs text-kasir-muted">
          Setelah ditutup, data shift ini permanen dan tidak bisa diubah siapa pun.
        </p>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={busy || counted === null}
          onClick={async () => {
            if (counted === null) return
            setBusy(true)
            setError(null)
            const outcome = await postJson<CloseResult>(`/api/shifts/${shift.id}/close`, {
              countedCash: counted,
              notes: notes.trim() || undefined,
            })
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            onClosed(outcome.data)
          }}
          className="mt-4 h-14 w-full rounded-xl bg-kasir-accent text-lg font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Menutup…' : 'Tutup shift'}
        </button>
      </section>
    </>
  )
}

function ClosedReport({ result, onDone }: { result: CloseResult; onDone: () => void }) {
  const { summary } = result
  return (
    <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <h2 className="text-base font-semibold text-kasir-text">Shift ditutup</h2>

      <dl className="mt-4 space-y-1 text-sm">
        <Row label="Uang seharusnya" value={formatRupiah(summary.expectedCash)} />
        <Row label="Uang dihitung" value={formatRupiah(summary.countedCash ?? 0)} />
      </dl>

      <div className="mt-3 flex items-baseline justify-between border-t border-kasir-border pt-3">
        <span className="text-sm text-kasir-muted">Selisih</span>
        <span
          className={`text-2xl font-semibold ${
            (summary.difference ?? 0) === 0 ? 'text-kasir-accent' : 'text-kasir-danger'
          }`}
        >
          {(summary.difference ?? 0) > 0 ? '+' : ''}
          {formatRupiah(summary.difference ?? 0)}
        </span>
      </div>

      {result.cancelledPending > 0 && (
        <p className="mt-3 text-sm text-kasir-muted">
          {result.cancelledPending} transaksi belum selesai ikut dibatalkan.
        </p>
      )}
      <p className="mt-1 text-xs text-kasir-muted">
        {result.backupFile ? `Backup tersimpan: ${result.backupFile}` : 'Backup gagal — periksa log.'}
      </p>

      <button
        type="button"
        onClick={onDone}
        className="mt-4 h-12 w-full rounded-xl border border-kasir-border text-base"
      >
        Selesai
      </button>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-kasir-muted">{label}</dt>
      <dd className="text-kasir-text">{value}</dd>
    </div>
  )
}
