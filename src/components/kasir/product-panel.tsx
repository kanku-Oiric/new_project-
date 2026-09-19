'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatRupiah } from '@/lib/money'
import type { KasirProduct } from './types'

/**
 * Kolom kiri: pencarian + daftar produk.
 *
 * Input pencarian dijaga tetap fokus, karena scanner barcode bekerja seperti
 * keyboard: ia mengetik kode lalu menekan Enter. Tanpa fokus yang terjaga,
 * kasir harus mengklik kolom dulu setiap kali — dan itu menghancurkan seluruh
 * manfaat scanner.
 */
export function ProductPanel({
  products,
  kategoriList,
  loading,
  onSearch,
  onScan,
  onPick,
}: {
  products: KasirProduct[]
  kategoriList: string[]
  loading: boolean
  onSearch: (query: string, kategori: string | null) => void
  onScan: (code: string) => void
  onPick: (product: KasirProduct) => void
}) {
  const [query, setQuery] = useState('')
  const [kategori, setKategori] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce pencarian ketik. Scan barcode tidak lewat sini — ia ditangani
  // Enter, yang jalurnya langsung tanpa menunggu debounce.
  useEffect(() => {
    const t = setTimeout(() => onSearch(query, kategori), 200)
    return () => clearTimeout(t)
  }, [query, kategori, onSearch])

  const refocus = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    refocus()
  }, [refocus])

  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            const code = query.trim()
            if (code.length === 0) return
            onScan(code)
            setQuery('')
          }}
          // Scanner mengirim karakter sangat cepat; autocomplete browser
          // kadang menyisipkan saran dan merusak kode yang terbaca.
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="search"
          placeholder="Scan barcode atau ketik nama / SKU"
          aria-label="Cari produk atau scan barcode"
          className="w-full rounded-xl border border-kasir-border bg-kasir-surface px-4 text-base outline-none focus:border-kasir-accent"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              refocus()
            }}
            className="shrink-0 rounded-xl border border-kasir-border bg-kasir-surface px-4 text-sm"
          >
            Hapus
          </button>
        )}
      </div>

      {kategoriList.length > 0 && (
        <div className="no-select flex gap-2 overflow-x-auto pb-1">
          <CategoryChip label="Semua" active={kategori === null} onClick={() => setKategori(null)} />
          {kategoriList.map((k) => (
            <CategoryChip
              key={k}
              label={k}
              active={kategori === k}
              onClick={() => setKategori(kategori === k ? null : k)}
            />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && products.length === 0 ? (
          <p className="p-4 text-sm text-kasir-muted">Memuat produk…</p>
        ) : products.length === 0 ? (
          <p className="p-4 text-sm text-kasir-muted">
            Tidak ada produk yang cocok. Periksa ejaan, atau scan barcodenya.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {products.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(p)
                    refocus()
                  }}
                  className="flex h-full w-full flex-col items-start gap-1 rounded-xl border border-kasir-border bg-kasir-surface p-3 text-left transition hover:border-kasir-accent"
                >
                  <span className="line-clamp-2 text-sm font-medium text-kasir-text">{p.nama}</span>
                  <span className="text-sm text-kasir-accent">{formatRupiah(p.hargaJual)}</span>
                  <StockBadge stok={p.stok} minimum={p.stokMinimum} satuan={p.satuan} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-4 text-sm ${
        active
          ? 'border-kasir-accent bg-kasir-accent text-white'
          : 'border-kasir-border bg-kasir-surface text-kasir-text'
      }`}
    >
      {label}
    </button>
  )
}

function StockBadge({
  stok,
  minimum,
  satuan,
}: {
  stok: number
  minimum: number
  satuan: string
}) {
  // Stok minus bukan penghalang penjualan, tapi harus terlihat. Kasir yang
  // melihat angka merah bisa langsung memberi tahu pemilik.
  const tone =
    stok < 0
      ? 'text-kasir-danger font-medium'
      : stok <= minimum
        ? 'text-kasir-warning'
        : 'text-kasir-muted'
  return (
    <span className={`text-xs ${tone}`}>
      Stok {stok} {satuan}
    </span>
  )
}
