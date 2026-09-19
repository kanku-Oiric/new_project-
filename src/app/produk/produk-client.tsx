'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { outcomeMessage, postJson } from '@/lib/api-client'
import { formatRupiah, parseRupiah } from '@/lib/money'

export interface ProdukRow {
  id: string
  sku: string
  nama: string
  kategori: string
  hargaBeli: number
  hargaJual: number
  stok: number
  stokMinimum: number
  satuan: string
}

export function ProdukClient({ initialProducts }: { initialProducts: ProdukRow[] }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [stockInFor, setStockInFor] = useState<ProdukRow | null>(null)

  const needle = query.trim().toLowerCase()
  const shown = needle
    ? initialProducts.filter(
        (p) =>
          p.nama.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle),
      )
    : initialProducts

  return (
    <>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Cari nama atau SKU"
        className="mb-3 w-full rounded-xl border border-kasir-border px-4 text-base"
      />

      <ul className="divide-y divide-kasir-border rounded-xl border border-kasir-border bg-kasir-surface">
        {shown.map((p) => (
          <li key={p.id} className="flex items-start justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-kasir-text">{p.nama}</p>
              <p className="text-xs text-kasir-muted">
                {p.sku} · beli {formatRupiah(p.hargaBeli, { bare: true })} · jual{' '}
                {formatRupiah(p.hargaJual, { bare: true })}
              </p>
              <p
                className={`text-xs ${
                  p.stok < 0
                    ? 'font-medium text-kasir-danger'
                    : p.stok <= p.stokMinimum
                      ? 'text-kasir-warning'
                      : 'text-kasir-muted'
                }`}
              >
                Stok {p.stok} {p.satuan}
                {p.stok <= p.stokMinimum && p.stok >= 0 ? ' · di bawah minimum' : ''}
                {p.stok < 0 ? ' · MINUS, perlu diperiksa' : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStockInFor(p)}
              className="shrink-0 rounded-lg border border-kasir-border px-3 text-sm text-kasir-text"
            >
              Barang masuk
            </button>
          </li>
        ))}
      </ul>

      {shown.length === 0 && (
        <p className="mt-3 text-sm text-kasir-muted">Tidak ada produk yang cocok.</p>
      )}

      {stockInFor && (
        <StockInDialog
          product={stockInFor}
          onClose={() => setStockInFor(null)}
          onDone={() => {
            setStockInFor(null)
            router.refresh()
          }}
        />
      )}
    </>
  )
}

/**
 * Barang masuk (restock).
 *
 * Harga beli baru bersifat opsional: kalau pemasok tidak menaikkan harga,
 * mengisinya hanya menambah baris audit yang tidak berarti.
 */
function StockInDialog({
  product,
  onClose,
  onDone,
}: {
  product: ProdukRow
  onClose: () => void
  onDone: () => void
}) {
  const [qtyText, setQtyText] = useState('')
  const [hargaText, setHargaText] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const qty = Number(qtyText) || 0
  const hargaBeli = (() => {
    if (hargaText.trim() === '') return undefined
    try {
      return parseRupiah(hargaText) ?? undefined
    } catch {
      return undefined
    }
  })()

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Barang masuk"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
    >
      <div className="w-full max-w-md rounded-t-2xl bg-kasir-surface p-4 sm:rounded-2xl">
        <h2 className="text-base font-semibold text-kasir-text">Barang masuk</h2>
        <p className="mt-1 text-sm text-kasir-muted">
          {product.nama} · stok sekarang {product.stok} {product.satuan}
        </p>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Jumlah masuk</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={qtyText}
            onChange={(e) => setQtyText(e.target.value)}
            className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">
            Harga beli baru (kosongkan kalau tidak berubah)
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={hargaText}
            placeholder={String(product.hargaBeli)}
            onChange={(e) => setHargaText(e.target.value)}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
          />
        </label>

        {hargaBeli !== undefined && hargaBeli !== product.hargaBeli && (
          <p className="mt-1 text-xs text-kasir-warning">
            Harga beli berubah {formatRupiah(product.hargaBeli)} → {formatRupiah(hargaBeli)}.
            Tercatat di audit log. HPP transaksi yang sudah terjadi tidak ikut berubah.
          </p>
        )}

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Catatan (opsional)</span>
          <input
            type="text"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
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
            onClick={onClose}
            disabled={busy}
            className="h-12 flex-1 rounded-xl border border-kasir-border text-base disabled:opacity-40"
          >
            Batal
          </button>
          <button
            type="button"
            disabled={busy || qty < 1}
            onClick={async () => {
              setBusy(true)
              setError(null)
              const outcome = await postJson(`/api/products/${product.id}/stock-in`, {
                qty,
                ...(hargaBeli === undefined ? {} : { hargaBeli }),
                note: note.trim() || undefined,
              })
              setBusy(false)
              if (outcome.kind !== 'ok') {
                setError(outcomeMessage(outcome, true))
                return
              }
              onDone()
            }}
            className="h-12 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Menyimpan…' : `Tambah ${qty || 0} ${product.satuan}`}
          </button>
        </div>
      </div>
    </div>
  )
}
