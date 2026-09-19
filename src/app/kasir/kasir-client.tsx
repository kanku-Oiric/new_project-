'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, outcomeMessage, postJson } from '@/lib/api-client'
import { computeCartDisplay, type CartDisplayTotals } from '@/lib/cart'
import type { PaymentMethod } from '@/lib/enums'
import { CartPanel } from '@/components/kasir/cart-panel'
import { PaymentDialog } from '@/components/kasir/payment-dialog'
import { ProductPanel } from '@/components/kasir/product-panel'
import type { CartItem, KasirProduct } from '@/components/kasir/types'

interface CheckoutResponse {
  transactionId: string
  trxNumber: string
  changeAmount: number | null
  negativeStock: { productName: string; stockAfter: number }[]
}

interface LastSale {
  trxNumber: string
  transactionId: string
  changeAmount: number | null
  negativeStock: { productName: string; stockAfter: number }[]
}

export function KasirClient({
  initialProducts,
  initialKategori,
  cashierName,
}: {
  initialProducts: KasirProduct[]
  initialKategori: string[]
  cashierName: string
}) {
  const [products, setProducts] = useState(initialProducts)
  const [kategoriList] = useState(initialKategori)
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<CartItem[]>([])
  const [transactionDiscount, setTransactionDiscount] = useState(0)
  const [paying, setPaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [lastSale, setLastSale] = useState<LastSale | null>(null)

  // Setiap pencarian membatalkan hasil pencarian sebelumnya, supaya respons
  // yang datang terlambat tidak menimpa hasil yang lebih baru.
  const searchSeq = useRef(0)

  const search = useCallback(async (query: string, kategori: string | null) => {
    const seq = ++searchSeq.current
    setLoading(true)
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (kategori) params.set('kategori', kategori)

    const outcome = await getJson<{ products: KasirProduct[] }>(`/api/products?${params}`)
    if (seq !== searchSeq.current) return

    if (outcome.kind === 'ok') {
      setProducts(outcome.data.products)
    } else {
      setBanner(outcomeMessage(outcome, false))
    }
    setLoading(false)
  }, [])

  const addToCart = useCallback((product: KasirProduct, qty = 1) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.productId === product.id)
      if (existing) {
        return prev.map((i) => (i.productId === product.id ? { ...i, qty: i.qty + qty } : i))
      }
      return [
        ...prev,
        {
          productId: product.id,
          nama: product.nama,
          sku: product.sku,
          satuan: product.satuan,
          hargaJual: product.hargaJual,
          stokTersedia: product.stok,
          qty,
          itemDiscount: 0,
        },
      ]
    })
    setBanner(null)
    setLastSale(null)
  }, [])

  /** Scanner barcode: kecocokan TEPAT, satu hasil, langsung masuk keranjang. */
  const handleScan = useCallback(
    async (code: string) => {
      const outcome = await getJson<{ product: KasirProduct }>(
        `/api/products/lookup?barcode=${encodeURIComponent(code)}`,
      )
      if (outcome.kind === 'ok') {
        addToCart(outcome.data.product)
        return
      }
      setBanner(outcomeMessage(outcome, false))
    },
    [addToCart],
  )

  const setQty = useCallback((productId: string, qty: number) => {
    setItems((prev) =>
      qty < 1
        ? prev.filter((i) => i.productId !== productId)
        : prev.map((i) => (i.productId === productId ? { ...i, qty } : i)),
    )
  }, [])

  const removeItem = useCallback((productId: string) => {
    setItems((prev) => prev.filter((i) => i.productId !== productId))
  }, [])

  const setItemDiscount = useCallback((productId: string, value: number) => {
    setItems((prev) =>
      prev.map((i) => (i.productId === productId ? { ...i, itemDiscount: value } : i)),
    )
  }, [])

  const clearCart = useCallback(() => {
    setItems([])
    setTransactionDiscount(0)
    setPayError(null)
  }, [])

  // Total dihitung modul murni yang sama dengan server. Kalau diskon melebihi
  // batas, computeCartDisplay melempar — ditangkap di sini dan ditampilkan
  // sebagai pesan, bukan membuat layar kasir putih.
  const { totals, cartError } = useMemo((): {
    totals: CartDisplayTotals | null
    cartError: string | null
  } => {
    if (items.length === 0) return { totals: null, cartError: null }
    try {
      return {
        totals: computeCartDisplay(
          items.map((i) => ({
            productId: i.productId,
            productName: i.nama,
            sku: i.sku,
            unitPrice: i.hargaJual,
            qty: i.qty,
            itemDiscount: i.itemDiscount,
          })),
          transactionDiscount,
        ),
        cartError: null,
      }
    } catch (e) {
      return { totals: null, cartError: e instanceof Error ? e.message : 'Keranjang tidak valid' }
    }
  }, [items, transactionDiscount])

  const pay = useCallback(
    async (method: PaymentMethod, amountTendered: number) => {
      if (!totals) return
      setBusy(true)
      setPayError(null)

      const outcome = await postJson<CheckoutResponse>('/api/transactions', {
        lines: items.map((i) => ({
          productId: i.productId,
          qty: i.qty,
          itemDiscount: i.itemDiscount,
        })),
        transactionDiscount,
        method,
        amountTendered,
      })

      if (outcome.kind !== 'ok') {
        // Pesannya dibedakan per keadaan: 4xx aman diperbaiki lalu diulang,
        // sedangkan 5xx dan kegagalan jaringan TIDAK — pada keduanya transaksi
        // mungkin sudah tersimpan, dan mengulang bisa berarti pelanggan
        // terbayar dua kali.
        setPayError(outcomeMessage(outcome, true))
        setBusy(false)
        return
      }

      const result = outcome.data
      setLastSale({
        trxNumber: result.trxNumber,
        transactionId: result.transactionId,
        changeAmount: result.changeAmount,
        negativeStock: result.negativeStock ?? [],
      })

      // Kembali ke keranjang kosong untuk transaksi berikutnya.
      setItems([])
      setTransactionDiscount(0)
      setPaying(false)
      setBusy(false)
      void search('', null)
    },
    [items, totals, transactionDiscount, search],
  )

  // Muat ulang daftar produk setelah penjualan supaya angka stok ikut segar.
  useEffect(() => {
    if (lastSale) void search('', null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSale?.trxNumber])

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-kasir-border bg-kasir-surface px-4 py-2">
        <h1 className="text-base font-semibold text-kasir-text">Kasir</h1>
        <span className="text-sm text-kasir-muted">{cashierName}</span>
      </header>

      {banner && (
        <p role="alert" className="bg-amber-50 px-4 py-2 text-sm text-kasir-warning">
          {banner}
        </p>
      )}

      {lastSale && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-green-50 px-4 py-2 text-sm">
          <span className="font-medium text-kasir-accent-strong">
            Tersimpan {lastSale.trxNumber}
          </span>
          {lastSale.changeAmount !== null && lastSale.changeAmount > 0 && (
            <span className="text-kasir-text">Kembalian Rp {lastSale.changeAmount.toLocaleString('id-ID')}</span>
          )}
          <a
            href={`/struk/${lastSale.transactionId}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Cetak struk
          </a>
          {lastSale.negativeStock.length > 0 && (
            <span className="w-full text-kasir-warning">
              Stok minus: {lastSale.negativeStock.map((n) => `${n.productName} (${n.stockAfter})`).join(', ')}
            </span>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[3fr_2fr]">
        <ProductPanel
          products={products}
          kategoriList={kategoriList}
          loading={loading}
          onSearch={search}
          onScan={handleScan}
          onPick={addToCart}
        />
        <CartPanel
          items={items}
          totals={totals}
          error={cartError}
          transactionDiscount={transactionDiscount}
          onQty={setQty}
          onRemove={removeItem}
          onItemDiscount={setItemDiscount}
          onTransactionDiscount={setTransactionDiscount}
          onClear={clearCart}
          onPay={() => {
            setPayError(null)
            setPaying(true)
          }}
        />
      </div>

      {paying && totals && (
        <PaymentDialog
          amount={totals.netTotal}
          busy={busy}
          error={payError}
          onCancel={() => setPaying(false)}
          onPay={pay}
        />
      )}
    </div>
  )
}
