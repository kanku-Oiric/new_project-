'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { deleteJson, outcomeMessage, postJson } from '@/lib/api-client'
import { formatRupiah, parseRupiah } from '@/lib/money'
import { useIdempotencyKey } from '@/lib/use-idempotency-key'
import { OwnerPinDialog } from '@/components/ui/owner-pin-dialog'

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
  const [deleteFor, setDeleteFor] = useState<ProdukRow | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const needle = query.trim().toLowerCase()
  const shown = needle
    ? initialProducts.filter(
        (p) =>
          p.nama.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle),
      )
    : initialProducts

  return (
    <>
      {notice && (
        <p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-kasir-text">{notice}</p>
      )}

      <div className="mb-3 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari nama atau SKU"
          className="min-w-0 flex-1 rounded-xl border border-kasir-border px-4 text-base"
        />
        <button
          type="button"
          onClick={() => {
            setNotice(null)
            setAdding(true)
          }}
          className="shrink-0 rounded-xl bg-kasir-accent px-4 text-sm font-medium text-white"
        >
          Tambah
        </button>
      </div>

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
            <div className="flex shrink-0 flex-col gap-1">
              <button
                type="button"
                onClick={() => setStockInFor(p)}
                className="rounded-lg border border-kasir-border px-3 py-1.5 text-sm text-kasir-text"
              >
                Barang masuk
              </button>
              <button
                type="button"
                onClick={() => {
                  setNotice(null)
                  setError(null)
                  setDeleteFor(p)
                }}
                className="rounded-lg px-3 py-1.5 text-sm text-kasir-danger"
              >
                Hapus
              </button>
            </div>
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

      {adding && (
        <ProductDialog
          onClose={() => setAdding(false)}
          onDone={(nama) => {
            setAdding(false)
            setNotice(`Produk ${nama} ditambahkan.`)
            router.refresh()
          }}
        />
      )}

      {deleteFor && (
        <OwnerPinDialog
          title={`Hapus ${deleteFor.nama}`}
          description={
            'Produk yang belum pernah terjual akan benar-benar dihapus. Produk yang sudah punya ' +
            'riwayat penjualan hanya dinonaktifkan — ia hilang dari layar kasir tapi tetap ada di ' +
            'laporan bulan-bulan sebelumnya, karena laba yang sudah dihitung berdiri di atas baris itu.'
          }
          confirmLabel="Hapus"
          reasonLabel={null}
          tone="danger"
          busy={busy}
          error={error}
          onCancel={() => setDeleteFor(null)}
          onConfirm={async (ownerPin) => {
            setBusy(true)
            setError(null)
            const outcome = await deleteJson<{ nama: string; hardDeleted: boolean }>(
              `/api/products/${deleteFor.id}`,
              { ownerPin },
            )
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            setDeleteFor(null)
            // Kalimatnya menyebut apa yang BENAR-BENAR terjadi. Mengatakan
            // "terhapus" untuk produk yang sebenarnya masih ada di database akan
            // membuat pemilik bingung saat namanya muncul lagi di laporan.
            setNotice(
              outcome.data.hardDeleted
                ? `Produk ${outcome.data.nama} dihapus.`
                : `Produk ${outcome.data.nama} dinonaktifkan — sudah punya riwayat penjualan, jadi barisnya tetap disimpan untuk laporan.`,
            )
            router.refresh()
          }}
        />
      )}
    </>
  )
}

/**
 * Tambah produk.
 *
 * Harga beli diminta di sini karena tanpanya laba kotor produk itu akan
 * dilaporkan sebagai seluruh harga jualnya. Boleh nol — ada barang titipan yang
 * memang tidak bermodal — tapi harus diisi sadar, bukan terlewat.
 */
function ProductDialog({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (nama: string) => void
}) {
  const [nama, setNama] = useState('')
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [kategori, setKategori] = useState('')
  const [beliText, setBeliText] = useState('')
  const [jualText, setJualText] = useState('')
  const [satuan, setSatuan] = useState('pcs')
  const [minText, setMinText] = useState('0')
  const [stokText, setStokText] = useState('0')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const angka = (text: string): number => {
    try {
      return parseRupiah(text) ?? 0
    } catch {
      return 0
    }
  }

  const hargaBeli = angka(beliText)
  const hargaJual = angka(jualText)
  const rugi = jualText.trim() !== '' && hargaJual < hargaBeli

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tambah produk"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-t-2xl bg-kasir-surface p-4 sm:rounded-2xl">
        <h2 className="text-base font-semibold text-kasir-text">Tambah produk</h2>

        <Field label="Nama" value={nama} onChange={setNama} autoFocus maxLength={120} />
        <Field label="SKU (kode barang)" value={sku} onChange={setSku} maxLength={40} />
        <Field
          label="Barcode (opsional)"
          value={barcode}
          onChange={setBarcode}
          maxLength={40}
          numeric
        />
        <Field label="Kategori" value={kategori} onChange={setKategori} maxLength={60} />

        <div className="flex gap-2">
          <div className="flex-1">
            <Field label="Harga beli" value={beliText} onChange={setBeliText} numeric />
          </div>
          <div className="flex-1">
            <Field label="Harga jual" value={jualText} onChange={setJualText} numeric />
          </div>
        </div>

        {rugi && (
          <p className="mt-1 text-xs text-kasir-warning">
            Harga jual di bawah harga beli — setiap penjualan produk ini akan tercatat rugi.
          </p>
        )}

        <div className="flex gap-2">
          <div className="flex-1">
            <Field label="Satuan" value={satuan} onChange={setSatuan} maxLength={20} />
          </div>
          <div className="flex-1">
            <Field label="Stok minimum" value={minText} onChange={setMinText} numeric />
          </div>
          <div className="flex-1">
            <Field label="Stok awal" value={stokText} onChange={setStokText} numeric />
          </div>
        </div>

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
            disabled={busy || nama.trim() === '' || sku.trim() === '' || kategori.trim() === ''}
            onClick={async () => {
              setBusy(true)
              setError(null)

              const outcome = await postJson('/api/products', {
                nama: nama.trim(),
                sku: sku.trim(),
                barcode: barcode.trim() || null,
                kategori: kategori.trim(),
                hargaBeli,
                hargaJual,
                satuan: satuan.trim() || 'pcs',
                stokMinimum: angka(minText),
                stokAwal: angka(stokText),
              })
              setBusy(false)
              if (outcome.kind !== 'ok') {
                setError(outcomeMessage(outcome, true))
                return
              }
              onDone(nama.trim())
            }}
            className="h-12 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  numeric,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  maxLength?: number
  numeric?: boolean
  autoFocus?: boolean
}) {
  return (
    <label className="mt-3 block">
      <span className="mb-1 block text-xs text-kasir-muted">{label}</span>
      <input
        type="text"
        autoFocus={autoFocus}
        inputMode={numeric ? 'numeric' : undefined}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-kasir-border px-3 text-base"
      />
    </label>
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

  // Kunci sekali-pakai: barang masuk yang terkirim dua kali menaikkan stok dua
  // kali, dan selisihnya baru ketahuan saat hitung fisik berikutnya.
  const keyFor = useIdempotencyKey()

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
              const payload = {
                qty,
                ...(hargaBeli === undefined ? {} : { hargaBeli }),
                note: note.trim() || undefined,
              }

              const idempotencyKey = keyFor(payload)
              if (idempotencyKey === null) {
                setError(
                  'Browser ini tidak bisa membuat kode pengaman, jadi barang masuk tidak bisa dicatat. ' +
                    'Gunakan browser lain (Chrome/Firefox versi baru) di perangkat ini.',
                )
                setBusy(false)
                return
              }

              const outcome = await postJson(`/api/products/${product.id}/stock-in`, {
                ...payload,
                idempotencyKey,
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
