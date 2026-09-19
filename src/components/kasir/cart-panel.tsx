'use client'

import { useState } from 'react'
import { formatRupiah, parseRupiah } from '@/lib/money'
import type { CartDisplayTotals } from '@/lib/cart'
import type { CartItem } from './types'

/**
 * Kolom kanan: keranjang.
 *
 * Totalnya dihitung `computeCartDisplay` — modul murni yang sama dengan yang
 * dipakai server. Server tetap menghitung ulang dari harga database dan tidak
 * mempercayai angka dari sini; yang dijamin adalah keduanya tidak akan berbeda
 * karena rumusnya berbeda.
 */
export function CartPanel({
  items,
  totals,
  error,
  transactionDiscount,
  onQty,
  onRemove,
  onItemDiscount,
  onTransactionDiscount,
  onClear,
  onPay,
}: {
  items: CartItem[]
  totals: CartDisplayTotals | null
  error: string | null
  transactionDiscount: number
  onQty: (productId: string, qty: number) => void
  onRemove: (productId: string) => void
  onItemDiscount: (productId: string, value: number) => void
  onTransactionDiscount: (value: number) => void
  onClear: () => void
  onPay: () => void
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-kasir-border bg-kasir-surface">
      <header className="flex items-center justify-between border-b border-kasir-border px-4 py-3">
        <h2 className="text-sm font-medium text-kasir-text">
          Keranjang{items.length > 0 ? ` · ${items.length} item` : ''}
        </h2>
        {items.length > 0 && (
          <button type="button" onClick={onClear} className="px-2 text-sm text-kasir-danger">
            Kosongkan
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="p-6 text-center text-sm text-kasir-muted">
            {/* Tanpa menyebut arah: di HP daftar produk ada di atas, bukan di kiri. */}
            Scan barcode atau pilih produk untuk mulai.
          </p>
        ) : (
          <ul className="divide-y divide-kasir-border">
            {items.map((item) => (
              <CartRow
                key={item.productId}
                item={item}
                lineFinal={
                  totals?.lines.find((l) => l.productId === item.productId)?.lineFinal ?? null
                }
                onQty={onQty}
                onRemove={onRemove}
                onItemDiscount={onItemDiscount}
              />
            ))}
          </ul>
        )}
      </div>

      {items.length > 0 && (
        <footer className="border-t border-kasir-border p-4">
          <DiscountField
            label="Diskon transaksi"
            value={transactionDiscount}
            onChange={onTransactionDiscount}
          />

          {error ? (
            <p role="alert" className="my-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
              {error}
            </p>
          ) : (
            totals && (
              <dl className="my-3 space-y-1 text-sm">
                <Row label="Subtotal" value={formatRupiah(totals.grossSubtotal)} />
                {totals.itemDiscountTotal > 0 && (
                  <Row
                    label="Diskon item"
                    value={`−${formatRupiah(totals.itemDiscountTotal, { bare: true })}`}
                  />
                )}
                {totals.transactionDiscount > 0 && (
                  <Row
                    label="Diskon transaksi"
                    value={`−${formatRupiah(totals.transactionDiscount, { bare: true })}`}
                  />
                )}
              </dl>
            )
          )}

          <div className="mb-3 flex items-baseline justify-between border-t border-kasir-border pt-3">
            <span className="text-sm text-kasir-muted">Total</span>
            <span className="text-2xl font-semibold text-kasir-text">
              {formatRupiah(totals?.netTotal ?? 0)}
            </span>
          </div>

          <button
            type="button"
            onClick={onPay}
            disabled={!totals || error !== null}
            className="h-14 w-full rounded-xl bg-kasir-accent text-lg font-medium text-white disabled:opacity-40"
          >
            Bayar
          </button>
        </footer>
      )}
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

function CartRow({
  item,
  lineFinal,
  onQty,
  onRemove,
  onItemDiscount,
}: {
  item: CartItem
  lineFinal: number | null
  onQty: (productId: string, qty: number) => void
  onRemove: (productId: string) => void
  onItemDiscount: (productId: string, value: number) => void
}) {
  const [showDiscount, setShowDiscount] = useState(item.itemDiscount > 0)
  const akanMinus = item.qty > item.stokTersedia

  return (
    <li className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-kasir-text">{item.nama}</p>
          <p className="text-xs text-kasir-muted">
            {formatRupiah(item.hargaJual)} / {item.satuan}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onRemove(item.productId)}
          aria-label={`Hapus ${item.nama}`}
          className="shrink-0 px-2 text-kasir-danger"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="no-select flex items-center gap-1">
          <StepButton label="−" onClick={() => onQty(item.productId, item.qty - 1)} />
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={item.qty}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isInteger(n)) onQty(item.productId, n)
            }}
            aria-label={`Jumlah ${item.nama}`}
            className="w-14 rounded-lg border border-kasir-border text-center text-base"
          />
          <StepButton label="+" onClick={() => onQty(item.productId, item.qty + 1)} />
        </div>

        <div className="text-right">
          <p className="text-base font-medium text-kasir-text">
            {lineFinal === null ? '—' : formatRupiah(lineFinal)}
          </p>
          <button
            type="button"
            onClick={() => setShowDiscount((v) => !v)}
            className="text-xs text-kasir-accent"
          >
            {item.itemDiscount > 0
              ? `Diskon ${formatRupiah(item.itemDiscount, { bare: true })}`
              : 'Diskon'}
          </button>
        </div>
      </div>

      {showDiscount && (
        <div className="mt-2">
          <DiscountField
            label="Diskon item (rupiah)"
            value={item.itemDiscount}
            onChange={(v) => onItemDiscount(item.productId, v)}
          />
        </div>
      )}

      {akanMinus && (
        // Tidak memblokir — penjualan nyata lebih penting daripada angka stok
        // yang memang sering tidak akurat. Tapi kasir harus tahu.
        <p className="mt-2 text-xs text-kasir-warning">
          Stok tercatat {item.stokTersedia}; setelah transaksi ini akan minus.
        </p>
      )}
    </li>
  )
}

function StepButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label === '+' ? 'Tambah' : 'Kurangi'}
      className="h-11 w-11 rounded-lg border border-kasir-border bg-kasir-bg text-lg"
    >
      {label}
    </button>
  )
}

/**
 * Input diskon dalam rupiah.
 *
 * Persen sengaja tidak ditawarkan di sini. Persen hanyalah kemudahan pengetikan
 * yang harus dikonversi ke rupiah sekali di titik input; menyimpannya sebagai
 * persen akan membuat total bergeser saat dihitung ulang. v1 meminta rupiah
 * langsung supaya tidak ada ruang bagi ketidakcocokan itu.
 */
function DiscountField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  const [text, setText] = useState(value > 0 ? String(value) : '')

  return (
    <label className="block">
      <span className="mb-1 block text-xs text-kasir-muted">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder="0"
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          if (raw.trim() === '') {
            onChange(0)
            return
          }
          try {
            onChange(parseRupiah(raw) ?? 0)
          } catch {
            // Ketikan setengah jadi ("1.0") bukan error yang perlu ditampilkan;
            // nilai terakhir yang sah tetap dipakai sampai ketikan selesai.
          }
        }}
        className="w-full rounded-lg border border-kasir-border px-3 text-base"
      />
    </label>
  )
}
