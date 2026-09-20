'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, outcomeMessage, postJson } from '@/lib/api-client'
import { computeCartDisplay, type CartDisplayTotals } from '@/lib/cart'
import type { PaymentMethod } from '@/lib/enums'
import { CartPanel } from '@/components/kasir/cart-panel'
import { PaymentDialog } from '@/components/kasir/payment-dialog'
import { ProductPanel } from '@/components/kasir/product-panel'
import { QrisPending } from '@/components/kasir/qris-pending'
import type { CartItem, KasirProduct } from '@/components/kasir/types'
import { Nav } from '@/components/ui/nav'
import type { Role } from '@/lib/enums'
import { useIdempotencyKey } from '@/lib/use-idempotency-key'

interface CheckoutResponse {
  transactionId: string
  trxNumber: string
  paymentId: string
  status: string
  netTotal: number
  changeAmount: number | null
  negativeStock: { productName: string; stockAfter: number }[]
  /** `true` = transaksi ini sudah tersimpan sebelumnya; ini bukan penjualan baru. */
  replayed?: boolean
}

interface ConfirmResponse {
  transactionId: string
  trxNumber: string
  negativeStock: { productName: string; stockAfter: number }[]
}

interface LastSale {
  trxNumber: string
  transactionId: string
  changeAmount: number | null
  negativeStock: { productName: string; stockAfter: number }[]
  /**
   * Penjualan ini sudah tersimpan pada percobaan sebelumnya. Kasir harus tahu,
   * supaya ia tidak menyangka baru saja terjadi penjualan kedua dan lalu
   * "memperbaiki"-nya dengan void yang sebenarnya tidak perlu.
   */
  replayed?: boolean
}

/** Transaksi QRIS yang sudah dibuat dan menunggu konfirmasi kasir. */
interface PendingQris {
  paymentId: string
  transactionId: string
  trxNumber: string
  amount: number
}

export function KasirClient({
  initialProducts,
  initialKategori,
  cashierName,
  role,
  qris,
  qrisImageUrl,
}: {
  initialProducts: KasirProduct[]
  initialKategori: string[]
  cashierName: string
  role: Role
  qris: { configured: boolean; label: string; hint: string | null }
  qrisImageUrl: string | null
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
  // Kunci sekali-pakai per isi keranjang: menekan Bayar dua kali karena jawaban
  // server tidak sampai tidak lagi bisa mencatat dua penjualan.
  const keyFor = useIdempotencyKey()
  const [pendingQris, setPendingQris] = useState<PendingQris | null>(null)
  const [qrisStatus, setQrisStatus] = useState<string | null>(null)

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

  /** Selesai: tampilkan struk, kosongkan keranjang, segarkan stok. */
  const finishSale = useCallback(
    (sale: LastSale) => {
      setLastSale(sale)
      setItems([])
      setTransactionDiscount(0)
      setPaying(false)
      setPendingQris(null)
      setQrisStatus(null)
      setBusy(false)
      void search('', null)
    },
    [search],
  )

  const pay = useCallback(
    async (method: PaymentMethod, amountTendered: number) => {
      if (!totals) return
      setBusy(true)
      setPayError(null)

      const payload = {
        lines: items.map((i) => ({
          productId: i.productId,
          qty: i.qty,
          itemDiscount: i.itemDiscount,
        })),
        transactionDiscount,
        method,
        // Hanya tunai punya uang yang diserahkan. Untuk QRIS, mengirim angka
        // apa pun di sini hanya akan membingungkan pembacaan data nanti.
        ...(method === 'CASH' ? { amountTendered } : {}),
      }

      // Kunci dihitung DARI payload, jadi ia otomatis berganti begitu keranjang,
      // diskon, metode, atau uang yang diserahkan berubah.
      const idempotencyKey = keyFor(payload)

      if (idempotencyKey === null) {
        // Server MEWAJIBKAN kunci. Mengirim tanpa kunci hanya menghasilkan 400
        // dengan pesan teknis; lebih jujur mengatakan sebabnya di sini. Terjadi
        // kalau browser tidak punya crypto.getRandomValues sama sekali.
        setPayError(
          'Browser ini tidak bisa membuat kode pengaman transaksi, jadi penjualan tidak bisa diproses. ' +
            'Gunakan browser lain (Chrome/Firefox versi baru) di perangkat ini.',
        )
        setBusy(false)
        return
      }

      const outcome = await postJson<CheckoutResponse>('/api/transactions', {
        ...payload,
        idempotencyKey,
      })

      if (outcome.kind !== 'ok') {
        // 4xx: datanya yang salah, aman diperbaiki lalu diulang.
        //
        // 5xx dan kegagalan jaringan: transaksinya MUNGKIN sudah tersimpan.
        // Dengan kunci sekali-pakai, mengulang tidak lagi berisiko mencatat
        // penjualan kedua — jadi kasir disuruh mengulang, bukan disuruh
        // memeriksa riwayat satu per satu. Tanpa kunci (browser tanpa sumber
        // acak), peringatan lamanya yang berlaku.
        setPayError(outcomeMessage(outcome, true, true))
        setBusy(false)
        return
      }

      const result = outcome.data

      // QRIS berhenti di PENDING. Stok BELUM berkurang dan tidak akan berkurang
      // sampai kasir mengonfirmasi (docs/qris.md §3.1).
      if (result.status === 'PENDING') {
        setPendingQris({
          paymentId: result.paymentId,
          transactionId: result.transactionId,
          trxNumber: result.trxNumber,
          amount: result.netTotal,
        })
        setQrisStatus(null)
        setBusy(false)
        return
      }

      finishSale({
        trxNumber: result.trxNumber,
        transactionId: result.transactionId,
        changeAmount: result.changeAmount,
        negativeStock: result.negativeStock ?? [],
        replayed: result.replayed === true,
      })
    },
    [items, totals, transactionDiscount, finishSale, keyFor],
  )

  /**
   * Konfirmasi pembayaran QRIS.
   *
   * Dipanggil HANYA dari tombol. Tidak ada efek, timer, atau interval di file
   * ini yang bisa memanggilnya sendiri.
   */
  const confirmQris = useCallback(async () => {
    if (!pendingQris) return
    setBusy(true)
    setPayError(null)

    const outcome = await postJson<ConfirmResponse>(
      `/api/payments/${pendingQris.paymentId}/confirm`,
      {},
    )

    if (outcome.kind !== 'ok') {
      setPayError(outcomeMessage(outcome, true))
      setBusy(false)
      return
    }

    finishSale({
      trxNumber: outcome.data.trxNumber,
      transactionId: outcome.data.transactionId,
      changeAmount: null,
      negativeStock: outcome.data.negativeStock ?? [],
    })
  }, [pendingQris, finishSale])

  /** Batalkan QRIS. Keranjang DIBIARKAN utuh supaya bisa lanjut ke tunai. */
  const cancelQris = useCallback(async () => {
    if (!pendingQris) return
    setBusy(true)
    setPayError(null)

    const outcome = await postJson(`/api/payments/${pendingQris.paymentId}/cancel`, {
      reason: 'Dibatalkan kasir di layar pembayaran',
    })

    setBusy(false)
    if (outcome.kind !== 'ok') {
      setPayError(outcomeMessage(outcome, true))
      return
    }

    setPendingQris(null)
    setQrisStatus(null)
    setBanner(
      `${pendingQris.trxNumber} dibatalkan. Keranjang masih utuh — bisa dilanjutkan dengan tunai.`,
    )
  }, [pendingQris])

  /** Baca status tersimpan. Tidak mengubah apa pun, di sisi mana pun. */
  const refreshQrisStatus = useCallback(async () => {
    if (!pendingQris) return
    const outcome = await getJson<{ status: string; transactionStatus: string }>(
      `/api/payments/${pendingQris.paymentId}/status`,
    )
    if (outcome.kind !== 'ok') {
      setPayError(outcomeMessage(outcome, false))
      return
    }
    setQrisStatus(outcome.data.status)
  }, [pendingQris])

  // Muat ulang daftar produk setelah penjualan supaya angka stok ikut segar.
  useEffect(() => {
    if (lastSale) void search('', null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSale?.trxNumber])

  return (
    <div className="flex h-dvh flex-col">
      {/* Navigasi yang sama dengan halaman lain. Layar kasir tidak boleh jadi
          jalan buntu: dari sini kasir harus bisa membuka shift, mencatat
          pengeluaran, membuka riwayat, dan menyerahkan layar ke rekannya. */}
      <Nav role={role} userName={cashierName} />

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
          {lastSale.replayed && (
            <span className="text-kasir-text">
              Sudah tersimpan sebelumnya — tidak dicatat dua kali.
            </span>
          )}
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

      {paying && totals && !pendingQris && (
        <PaymentDialog
          amount={totals.netTotal}
          busy={busy}
          error={payError}
          qris={qris}
          onCancel={() => setPaying(false)}
          onPay={pay}
        />
      )}

      {pendingQris && (
        <QrisPending
          trxNumber={pendingQris.trxNumber}
          amount={pendingQris.amount}
          qrImageUrl={qrisImageUrl}
          storedStatus={qrisStatus}
          busy={busy}
          error={payError}
          onConfirm={confirmQris}
          onCancel={cancelQris}
          onRefreshStatus={refreshQrisStatus}
        />
      )}
    </div>
  )
}
