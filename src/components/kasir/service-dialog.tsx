'use client'

import { useState } from 'react'
import { formatRupiah, parseRupiah } from '@/lib/money'
import { serviceSpec } from '@/lib/service/catalog'
import type { ServiceKind } from '@/lib/enums'
import type { CartServiceItem, KasirProvider } from './types'

/**
 * Form satu baris jasa: nominal, biaya admin, provider, nomor tujuan.
 *
 * Yang ditampilkan besar adalah TOTAL yang harus diserahkan pelanggan —
 * nominal ditambah admin — karena itulah angka yang diucapkan kasir. Omzet
 * toko ditulis kecil di bawahnya, bukan karena tidak penting, tapi karena
 * kasir tidak pernah menyebut angka itu kepada pelanggan.
 *
 * Untuk tarik tunai, yang besar justru uang yang DISERAHKAN KE pelanggan, dan
 * kalimatnya berubah. Salah baca di sini berarti uang tunai berpindah ke arah
 * yang salah.
 */
export function ServiceDialog({
  kind,
  providers,
  defaultFee,
  onCancel,
  onAdd,
}: {
  kind: ServiceKind
  providers: KasirProvider[]
  defaultFee: number
  onCancel: () => void
  onAdd: (line: Omit<CartServiceItem, 'lineId'>) => void
}) {
  const spec = serviceSpec(kind)
  const masuk = spec.direction === 'PROVIDER_IN'

  const [nominalText, setNominalText] = useState('')
  const [feeText, setFeeText] = useState(String(defaultFee))
  const [costText, setCostText] = useState('')
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const [customerRef, setCustomerRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  const angka = (text: string, fallback: number): number => {
    if (text.trim() === '') return fallback
    try {
      return parseRupiah(text) ?? fallback
    } catch {
      return fallback
    }
  }

  const nominal = angka(nominalText, 0)
  const fee = angka(feeText, 0)
  const cost = angka(costText, 0)
  const provider = providers.find((p) => p.id === providerId) ?? null

  const total = masuk ? nominal - fee : nominal + fee
  const saldoKurang = provider !== null && !masuk && provider.saldo < nominal

  function submit(): void {
    if (nominal < 1) {
      setError('Nominal wajib diisi')
      return
    }
    if (!provider) {
      setError('Pilih provider dulu')
      return
    }
    if (masuk && fee >= nominal) {
      setError('Biaya admin harus lebih kecil daripada nominal')
      return
    }

    onAdd({
      kind,
      label: spec.label,
      direction: spec.direction,
      providerId: provider.id,
      providerName: provider.nama,
      passthroughAmount: nominal,
      serviceFeeAmount: fee,
      providerCostAmount: cost,
      customerRef: customerRef.trim() || undefined,
    })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={spec.label}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-t-2xl bg-kasir-surface p-4 sm:rounded-2xl">
        <h2 className="text-base font-semibold text-kasir-text">{spec.label}</h2>
        <p className="mt-0.5 text-sm text-kasir-muted">{spec.hint}</p>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">
            {masuk ? 'Nominal yang ditransfer pelanggan' : 'Nominal'}
          </span>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            value={nominalText}
            onChange={(e) => {
              setNominalText(e.target.value)
              setError(null)
            }}
            className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
          />
        </label>

        {spec.quickAmounts.length > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-2">
            {spec.quickAmounts.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setNominalText(String(v))
                  setError(null)
                }}
                className="h-11 rounded-lg border border-kasir-border text-sm"
              >
                {v >= 1_000 ? `${v / 1_000}rb` : formatRupiah(v, { bare: true })}
              </button>
            ))}
          </div>
        )}

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Biaya admin (pendapatan toko)</span>
          <input
            type="text"
            inputMode="numeric"
            value={feeText}
            onChange={(e) => {
              setFeeText(e.target.value)
              setError(null)
            }}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">
            Potongan provider (opsional — isi kalau aplikasi memotong biaya ke toko)
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={costText}
            placeholder="0"
            onChange={(e) => setCostText(e.target.value)}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
          />
        </label>

        <fieldset className="mt-3">
          <legend className="mb-1 text-xs text-kasir-muted">
            {masuk ? 'Masuk ke akun' : 'Dibayar dari akun'}
          </legend>
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProviderId(p.id)}
                className={`flex min-h-[44px] flex-col items-start rounded-lg border px-3 py-1 text-left ${
                  p.id === providerId
                    ? 'border-kasir-accent bg-kasir-accent/10'
                    : 'border-kasir-border'
                }`}
              >
                <span className="text-sm text-kasir-text">{p.nama}</span>
                <span
                  className={`text-[11px] ${p.saldo <= 0 ? 'text-kasir-danger' : 'text-kasir-muted'}`}
                >
                  {formatRupiah(p.saldo, { bare: true })}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        {saldoKurang && (
          // Peringatan, bukan penghalang — keputusan yang sama seperti stok
          // minus. Saldo tercatat bisa saja tertinggal dari saldo asli, dan
          // menolak penjualan nyata karena angka yang mungkin sudah usang lebih
          // merugikan daripada mencatat saldo minus lalu merekonsiliasinya.
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-kasir-warning">
            Saldo {provider?.nama} tercatat {formatRupiah(provider?.saldo ?? 0)}, kurang dari
            nominal. Transaksi tetap bisa dilanjutkan dan saldo akan tercatat minus — periksa
            saldo asli di aplikasinya.
          </p>
        )}

        {spec.refLabel && (
          <label className="mt-3 block">
            <span className="mb-1 block text-xs text-kasir-muted">{spec.refLabel} (opsional)</span>
            <input
              type="text"
              inputMode="numeric"
              value={customerRef}
              maxLength={60}
              onChange={(e) => setCustomerRef(e.target.value)}
              className="w-full rounded-lg border border-kasir-border px-3 text-base"
            />
          </label>
        )}

        <div className="mt-4 rounded-xl bg-kasir-bg p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-kasir-muted">
              {masuk ? 'Diserahkan ke pelanggan' : 'Dibayar pelanggan'}
            </span>
            <span className="text-2xl font-semibold text-kasir-text">
              {formatRupiah(Math.max(total, 0))}
            </span>
          </div>
          <p className="mt-1 text-xs text-kasir-muted">
            Titipan {formatRupiah(nominal)} · omzet toko {formatRupiah(fee)}
            {cost > 0 && ` · potongan provider ${formatRupiah(cost)}`}
          </p>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-12 flex-1 rounded-xl border border-kasir-border text-base"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={submit}
            className="h-12 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white"
          >
            Tambah ke keranjang
          </button>
        </div>
      </div>
    </div>
  )
}
