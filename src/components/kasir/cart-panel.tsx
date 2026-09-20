'use client'

import { useState } from 'react'
import { formatRupiah, parseRupiah } from '@/lib/money'
import type { CartServiceTotals } from '@/lib/cart/services'
import type { CartItem, CartServiceItem } from './types'

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
  services,
  totals,
  error,
  transactionDiscount,
  onQty,
  onRemove,
  onRemoveService,
  onItemDiscount,
  onTransactionDiscount,
  onClear,
  onPay,
}: {
  items: CartItem[]
  services: CartServiceItem[]
  totals: CartServiceTotals | null
  error: string | null
  transactionDiscount: number
  onQty: (productId: string, qty: number) => void
  onRemove: (productId: string) => void
  onRemoveService: (lineId: string) => void
  onItemDiscount: (productId: string, value: number) => void
  onTransactionDiscount: (value: number) => void
  onClear: () => void
  onPay: () => void
}) {
  const jumlahBaris = items.length + services.length
  const keluar = totals?.payDirection === 'OUT'

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-kasir-border bg-kasir-surface">
      <header className="flex items-center justify-between border-b border-kasir-border px-4 py-3">
        <h2 className="text-sm font-medium text-kasir-text">
          Keranjang{jumlahBaris > 0 ? ` · ${jumlahBaris} baris` : ''}
        </h2>
        {jumlahBaris > 0 && (
          <button type="button" onClick={onClear} className="px-2 text-sm text-kasir-danger">
            Kosongkan
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {jumlahBaris === 0 ? (
          <p className="p-6 text-center text-sm text-kasir-muted">
            {/* Tanpa menyebut arah: di HP daftar produk ada di atas, bukan di kiri. */}
            Scan barcode, pilih produk, atau pilih jasa pembayaran untuk mulai.
          </p>
        ) : (
          <ul className="divide-y divide-kasir-border">
            {items.map((item) => (
              <CartRow
                key={item.productId}
                item={item}
                lineFinal={
                  totals?.goods?.lines.find((l) => l.productId === item.productId)?.lineFinal ??
                  null
                }
                onQty={onQty}
                onRemove={onRemove}
                onItemDiscount={onItemDiscount}
              />
            ))}
            {services.map((jasa) => (
              <ServiceRow key={jasa.lineId} jasa={jasa} onRemove={onRemoveService} />
            ))}
          </ul>
        )}
      </div>

      {jumlahBaris > 0 && (
        <footer className="border-t border-kasir-border p-4">
          {items.length > 0 && (
            // Diskon transaksi dialokasikan atas barang saja. Menurunkan titipan
            // mustahil — provider tetap dibayar penuh — dan diskon atas biaya
            // admin lebih jujur dengan mengisi biaya adminnya lebih kecil. Karena
            // itu kolomnya tidak ditampilkan untuk keranjang berisi jasa saja,
            // bukan ditampilkan lalu ditolak server.
            <DiscountField
              label="Diskon transaksi"
              value={transactionDiscount}
              onChange={onTransactionDiscount}
            />
          )}

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
                {totals.passthroughTotal !== 0 && (
                  <Row
                    label="Titipan jasa (bukan omzet)"
                    value={formatRupiah(totals.passthroughTotal)}
                  />
                )}
              </dl>
            )
          )}

          <div className="mb-3 border-t border-kasir-border pt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-kasir-muted">
                {/* Kalimatnya berubah saat uang justru KELUAR dari laci. Kasir
                    yang membaca "Total" lalu menerima uang dari pelanggan pada
                    transaksi tarik tunai akan membuat kesalahan dua arah
                    sekaligus. */}
                {keluar ? 'Serahkan ke pelanggan' : 'Total'}
              </span>
              <span
                className={`text-2xl font-semibold ${keluar ? 'text-kasir-warning' : 'text-kasir-text'}`}
              >
                {formatRupiah(totals?.payAmount ?? 0)}
              </span>
            </div>
            {totals && totals.serviceFeeTotal > 0 && (
              <p className="mt-1 text-right text-xs text-kasir-muted">
                Omzet toko dari transaksi ini {formatRupiah(totals.netTotal)}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onPay}
            disabled={!totals || error !== null}
            className={`h-14 w-full rounded-xl text-lg font-medium text-white disabled:opacity-40 ${
              keluar ? 'bg-kasir-warning' : 'bg-kasir-accent'
            }`}
          >
            {keluar ? 'Serahkan uang' : 'Bayar'}
          </button>
        </footer>
      )}
    </section>
  )
}

function ServiceRow({
  jasa,
  onRemove,
}: {
  jasa: CartServiceItem
  onRemove: (lineId: string) => void
}) {
  const masuk = jasa.direction === 'PROVIDER_IN'

  return (
    <li className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-kasir-text">
            {jasa.label}
            <span className="ml-2 rounded bg-kasir-bg px-1.5 py-0.5 text-[11px] text-kasir-muted">
              {jasa.providerName}
            </span>
          </p>
          <p className="text-xs text-kasir-muted">
            {masuk ? 'Terima transfer' : 'Titipan'} {formatRupiah(jasa.passthroughAmount)} · admin{' '}
            {formatRupiah(jasa.serviceFeeAmount)}
          </p>
          {jasa.customerRef && (
            <p className="truncate text-xs text-kasir-muted">No. {jasa.customerRef}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm text-kasir-text">
            {masuk
              ? `−${formatRupiah(jasa.passthroughAmount - jasa.serviceFeeAmount, { bare: true })}`
              : formatRupiah(jasa.passthroughAmount + jasa.serviceFeeAmount)}
          </p>
          <button
            type="button"
            onClick={() => onRemove(jasa.lineId)}
            className="mt-1 text-xs text-kasir-danger"
          >
            Hapus
          </button>
        </div>
      </div>
    </li>
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
