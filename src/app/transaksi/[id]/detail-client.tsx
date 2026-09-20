'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { outcomeMessage, postJson } from '@/lib/api-client'
import { formatRupiah } from '@/lib/money'
import { MANUAL_REFUND_WARNING } from '@/lib/transaction/void-rules'
import { OwnerPinDialog } from '@/components/ui/owner-pin-dialog'
import { useIdempotencyKey } from '@/lib/use-idempotency-key'

export interface DetailItem {
  id: string
  productName: string
  qty: number
  unitPrice: number
  lineFinal: number
  refundedQty: number
  refundedAmount: number
}

export interface DetailRefund {
  id: string
  refundNumber: string
  amount: number
  method: string
  reason: string
  createdAt: string
}

interface Props {
  transactionId: string
  trxNumber: string
  status: string
  cashierName: string
  createdAt: string
  grossSubtotal: number
  itemDiscountTotal: number
  transactionDiscount: number
  netTotal: number
  paymentMethod: string
  paymentStatus: string
  voidReason: string | null
  items: DetailItem[]
  refunds: DetailRefund[]
  canVoid: boolean
  voidBlockedReason: string | null
  needsManualRefund: boolean
}

export function TransactionDetail(props: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<'none' | 'void' | 'refund'>('none')
  const [refundQty, setRefundQty] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const sisaRefund = props.items.reduce((s, i) => s + (i.qty - i.refundedQty), 0)
  const bisaRefund = props.status === 'COMPLETED' && sisaRefund > 0
  const totalRefunded = props.refunds.reduce((s, r) => s + r.amount, 0)

  const pilihan = Object.entries(refundQty).filter(([, q]) => q > 0)
  const nominalRefund = pilihan.reduce((sum, [itemId, q]) => {
    const item = props.items.find((i) => i.id === itemId)
    if (!item) return sum
    // Pratinjau memakai rumus teleskopik yang sama dengan server.
    const kumulatif = item.refundedQty + q
    const target = Math.floor((item.lineFinal * kumulatif) / item.qty)
    return sum + (target - item.refundedAmount)
  }, 0)

  return (
    <>
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-kasir-text">{props.trxNumber}</h1>
        <p className="text-sm text-kasir-muted">
          {props.cashierName} · {new Date(props.createdAt).toLocaleString('id-ID')}
        </p>
        {props.status !== 'COMPLETED' && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
            Transaksi {props.status === 'VOIDED' ? 'dibatalkan' : props.status.toLowerCase()}
            {props.voidReason ? ` — ${props.voidReason}` : ''}
          </p>
        )}
      </header>

      {notice && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-kasir-warning">
          {notice}
        </p>
      )}

      <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <ul className="divide-y divide-kasir-border">
          {props.items.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-kasir-text">{i.productName}</p>
                <p className="text-xs text-kasir-muted">
                  {i.qty} × {formatRupiah(i.unitPrice, { bare: true })}
                  {i.refundedQty > 0 && ` · ${i.refundedQty} sudah di-refund`}
                </p>
              </div>
              <span className="shrink-0 text-sm text-kasir-text">{formatRupiah(i.lineFinal)}</span>
            </li>
          ))}
        </ul>

        <dl className="mt-3 space-y-1 border-t border-kasir-border pt-3 text-sm">
          <Row label="Subtotal" value={formatRupiah(props.grossSubtotal)} />
          {props.itemDiscountTotal > 0 && (
            <Row label="Diskon item" value={`−${formatRupiah(props.itemDiscountTotal, { bare: true })}`} />
          )}
          {props.transactionDiscount > 0 && (
            <Row label="Diskon transaksi" value={`−${formatRupiah(props.transactionDiscount, { bare: true })}`} />
          )}
          <Row label="Total" value={formatRupiah(props.netTotal)} />
          <Row
            label="Pembayaran"
            value={`${props.paymentMethod === 'CASH' ? 'Tunai' : 'QRIS'} · ${props.paymentStatus}`}
          />
        </dl>
      </section>

      {props.refunds.length > 0 && (
        <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-kasir-text">Refund</h2>
            <span className="text-sm text-kasir-danger">
              −{formatRupiah(totalRefunded, { bare: true })}
            </span>
          </div>
          <ul className="mt-2 divide-y divide-kasir-border">
            {props.refunds.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-kasir-text">{r.refundNumber}</p>
                  <p className="truncate text-xs text-kasir-muted">
                    {r.method} · {r.reason}
                  </p>
                </div>
                <span className="shrink-0 text-sm text-kasir-text">{formatRupiah(r.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-4 grid gap-2 sm:grid-cols-2">
        <div>
          <button
            type="button"
            disabled={!props.canVoid}
            onClick={() => {
              setError(null)
              setMode('void')
            }}
            className="h-12 w-full rounded-xl border border-kasir-danger text-base text-kasir-danger disabled:border-kasir-border disabled:text-kasir-muted disabled:opacity-60"
          >
            Batalkan transaksi
          </button>
          {/* Tombol mati SELALU menyebutkan alasannya dan jalan keluarnya.
              Tombol mati tanpa penjelasan membuat kasir menebak, lalu menelepon
              pemilik untuk hal yang sudah punya jawaban. */}
          {!props.canVoid && props.voidBlockedReason && (
            <p className="mt-1 text-xs text-kasir-muted">{props.voidBlockedReason}</p>
          )}
        </div>

        <div>
          <button
            type="button"
            disabled={!bisaRefund}
            onClick={() => {
              setError(null)
              setRefundQty({})
              setMode('refund')
            }}
            className="h-12 w-full rounded-xl border border-kasir-border text-base text-kasir-text disabled:opacity-60"
          >
            Refund
          </button>
          {!bisaRefund && (
            <p className="mt-1 text-xs text-kasir-muted">
              {props.status !== 'COMPLETED'
                ? 'Hanya transaksi lunas yang bisa di-refund'
                : 'Semua item sudah di-refund'}
            </p>
          )}
        </div>
      </section>

      {mode === 'refund' && (
        <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <h2 className="text-base font-semibold text-kasir-text">Pilih item yang di-refund</h2>
          <ul className="mt-2 divide-y divide-kasir-border">
            {props.items.map((i) => {
              const sisa = i.qty - i.refundedQty
              return (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-kasir-text">{i.productName}</p>
                    <p className="text-xs text-kasir-muted">sisa {sisa} dari {i.qty}</p>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={sisa}
                    disabled={sisa === 0}
                    value={refundQty[i.id] ?? 0}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(sisa, Number(e.target.value) || 0))
                      setRefundQty((prev) => ({ ...prev, [i.id]: v }))
                    }}
                    className="w-20 shrink-0 rounded-lg border border-kasir-border text-center text-base disabled:opacity-40"
                  />
                </li>
              )
            })}
          </ul>

          <div className="mt-3 flex items-baseline justify-between border-t border-kasir-border pt-3">
            <span className="text-sm text-kasir-muted">Nominal refund</span>
            <span className="text-xl font-semibold text-kasir-text">
              {formatRupiah(nominalRefund)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setMode('none')}
            className="mt-3 h-12 w-full rounded-xl border border-kasir-border text-base"
          >
            Batal
          </button>
        </section>
      )}

      {mode === 'void' && (
        <OwnerPinDialog
          title="Batalkan transaksi"
          description={`${props.trxNumber} — ${formatRupiah(props.netTotal)}`}
          warning={props.needsManualRefund ? MANUAL_REFUND_WARNING : null}
          confirmLabel="Batalkan"
          reasonLabel="Alasan pembatalan"
          busy={busy}
          error={error}
          onCancel={() => setMode('none')}
          onConfirm={async (ownerPin, reason) => {
            setBusy(true)
            setError(null)
            const outcome = await postJson<{ needsManualRefund: boolean }>(
              `/api/transactions/${props.transactionId}/void`,
              { ownerPin, reason },
            )
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            setMode('none')
            if (outcome.data.needsManualRefund) {
              setNotice(MANUAL_REFUND_WARNING)
            }
            router.refresh()
          }}
        />
      )}

      {mode === 'refund' && pilihan.length > 0 && (
        <RefundConfirm
          transactionId={props.transactionId}
          nominal={nominalRefund}
          items={pilihan.map(([transactionItemId, qty]) => ({ transactionItemId, qty }))}
          busy={busy}
          error={error}
          setBusy={setBusy}
          setError={setError}
          onDone={() => {
            setMode('none')
            setRefundQty({})
            router.refresh()
          }}
        />
      )}
    </>
  )
}

function RefundConfirm({
  transactionId,
  nominal,
  items,
  busy,
  error,
  setBusy,
  setError,
  onDone,
}: {
  transactionId: string
  nominal: number
  items: { transactionItemId: string; qty: number }[]
  busy: boolean
  error: string | null
  setBusy: (v: boolean) => void
  setError: (v: string | null) => void
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  // Refund sebagian yang diulang tidak boleh menjadi dua kali uang keluar.
  const keyFor = useIdempotencyKey()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 h-12 w-full rounded-xl bg-kasir-danger text-base font-medium text-white"
      >
        Proses refund {formatRupiah(nominal)}
      </button>
    )
  }

  return (
    <OwnerPinDialog
      title="Proses refund"
      description={`Nominal ${formatRupiah(nominal)} akan dikeluarkan dari laci shift ini.`}
      confirmLabel="Refund"
      reasonLabel="Alasan refund"
      busy={busy}
      error={error}
      onCancel={() => setOpen(false)}
      onConfirm={async (ownerPin, reason) => {
        setBusy(true)
        setError(null)

        // PIN sengaja TIDAK ikut menentukan kunci: kalau ia ikut, salah ketik PIN
        // lalu mengulang akan menghasilkan kunci baru dan refund kedua. Yang
        // menentukan adalah apa yang dikembalikan dan alasannya.
        const payload = { items, method: 'CASH', reason }
        const idempotencyKey = keyFor(payload)

        if (idempotencyKey === null) {
          // Server mewajibkan kunci — lihat kasir-client.tsx untuk alasannya.
          setBusy(false)
          setError(
            'Browser ini tidak bisa membuat kode pengaman transaksi, jadi refund tidak bisa diproses. ' +
              'Gunakan browser lain di perangkat ini.',
          )
          return
        }

        const outcome = await postJson(`/api/transactions/${transactionId}/refunds`, {
          ownerPin,
          ...payload,
          idempotencyKey,
        })
        setBusy(false)
        if (outcome.kind !== 'ok') {
          setError(outcomeMessage(outcome, true, true))
          return
        }
        setOpen(false)
        onDone()
      }}
    />
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
