'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, outcomeMessage, postJson } from '@/lib/api-client'
import {
  computeCartWithServices,
  type CartServiceTotals,
} from '@/lib/cart/services'
import type { PaymentMethod, ServiceKind } from '@/lib/enums'
import { feeDefaults } from '@/lib/service/catalog'
import { CartPanel } from '@/components/kasir/cart-panel'
import { PaymentDialog } from '@/components/kasir/payment-dialog'
import { ProductPanel } from '@/components/kasir/product-panel'
import { ServiceDialog } from '@/components/kasir/service-dialog'
import { ServiceRail } from '@/components/kasir/service-rail'
import type {
  CartItem,
  CartServiceItem,
  KasirProduct,
  KasirProvider,
} from '@/components/kasir/types'
import { Nav } from '@/components/ui/nav'
import type { Role } from '@/lib/enums'
import { useIdempotencyKey } from '@/lib/use-idempotency-key'

interface CheckoutResponse {
  transactionId: string
  trxNumber: string
  paymentId: string
  status: string
  /** OMZET. Untuk transaksi jasa ini JAUH lebih kecil daripada uang yang berpindah. */
  netTotal: number
  passthroughTotal: number
  /** Uang yang benar-benar berpindah — yang diucapkan kasir ke pelanggan. */
  payAmount: number
  payDirection: 'IN' | 'OUT'
  providerBalances: { providerId: string; providerName: string; balanceAfter: number }[]
  changeAmount: number | null
  negativeStock: { productName: string; stockAfter: number }[]
  /** `true` = transaksi ini sudah tersimpan sebelumnya; ini bukan penjualan baru. */
  replayed?: boolean
}

interface LastSale {
  trxNumber: string
  transactionId: string
  changeAmount: number | null
  negativeStock: { productName: string; stockAfter: number }[]
  /** Saldo provider setelah transaksi ini — supaya kasir langsung tahu sisanya. */
  providerBalances?: { providerName: string; balanceAfter: number }[]
  /**
   * Penjualan ini sudah tersimpan pada percobaan sebelumnya. Kasir harus tahu,
   * supaya ia tidak menyangka baru saja terjadi penjualan kedua dan lalu
   * "memperbaiki"-nya dengan void yang sebenarnya tidak perlu.
   */
  replayed?: boolean
}

export function KasirClient({
  initialProducts,
  initialKategori,
  initialProviders,
  serviceFees,
  cashierName,
  role,
  qris,
}: {
  initialProducts: KasirProduct[]
  initialKategori: string[]
  initialProviders: KasirProvider[]
  /** Biaya admin bawaan per jenis jasa, sudah ditimpa setting pemilik. */
  serviceFees: Record<string, number>
  cashierName: string
  role: Role
  qris: { configured: boolean; label: string; hint: string | null }
}) {
  const [products, setProducts] = useState(initialProducts)
  const [kategoriList] = useState(initialKategori)
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<CartItem[]>([])
  const [services, setServices] = useState<CartServiceItem[]>([])
  const [providers, setProviders] = useState(initialProviders)
  const [serviceKind, setServiceKind] = useState<ServiceKind | null>(null)
  const [transactionDiscount, setTransactionDiscount] = useState(0)
  const [paying, setPaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [lastSale, setLastSale] = useState<LastSale | null>(null)
  // Kunci sekali-pakai per isi keranjang: menekan Bayar dua kali karena jawaban
  // server tidak sampai tidak lagi bisa mencatat dua penjualan.
  const keyFor = useIdempotencyKey()

  // Setiap pencarian membatalkan hasil pencarian sebelumnya, supaya respons
  // yang datang terlambat tidak menimpa hasil yang lebih baru.
  const searchSeq = useRef(0)

  // Penomoran baris jasa. Bukan UUID: crypto.randomUUID undefined di HP kasir
  // yang membuka lewat IP LAN (src/lib/idempotency.ts), dan yang dibutuhkan di
  // sini cuma pembeda antar-baris di dalam satu keranjang.
  const serviceSeq = useRef(0)

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

  const addService = useCallback((line: Omit<CartServiceItem, 'lineId'>) => {
    serviceSeq.current += 1
    setServices((prev) => [...prev, { ...line, lineId: `jasa-${serviceSeq.current}` }])
    setServiceKind(null)
    setBanner(null)
    setLastSale(null)
  }, [])

  const removeService = useCallback((lineId: string) => {
    setServices((prev) => prev.filter((j) => j.lineId !== lineId))
  }, [])

  /** Muat ulang saldo provider — dipanggil setelah transaksi jasa selesai. */
  const refreshProviders = useCallback(async () => {
    const outcome = await getJson<{ providers: KasirProvider[] }>('/api/providers')
    if (outcome.kind === 'ok') setProviders(outcome.data.providers)
  }, [])

  const clearCart = useCallback(() => {
    setItems([])
    setServices([])
    setTransactionDiscount(0)
    setPayError(null)
  }, [])

  // Total dihitung modul murni yang sama dengan server. Kalau diskon melebihi
  // batas, computeCartDisplay melempar — ditangkap di sini dan ditampilkan
  // sebagai pesan, bukan membuat layar kasir putih.
  const { totals, cartError } = useMemo((): {
    totals: CartServiceTotals | null
    cartError: string | null
  } => {
    if (items.length === 0 && services.length === 0) return { totals: null, cartError: null }
    try {
      return {
        totals: computeCartWithServices(
          items.map((i) => ({
            productId: i.productId,
            productName: i.nama,
            sku: i.sku,
            unitPrice: i.hargaJual,
            qty: i.qty,
            itemDiscount: i.itemDiscount,
          })),
          services.map((j) => ({
            kind: j.kind,
            direction: j.direction,
            label: j.label,
            providerId: j.providerId,
            providerName: j.providerName,
            passthroughAmount: j.passthroughAmount,
            serviceFeeAmount: j.serviceFeeAmount,
            providerCostAmount: j.providerCostAmount,
            customerRef: j.customerRef,
          })),
          transactionDiscount,
        ),
        cartError: null,
      }
    } catch (e) {
      return { totals: null, cartError: e instanceof Error ? e.message : 'Keranjang tidak valid' }
    }
  }, [items, services, transactionDiscount])

  /** Selesai: tampilkan struk, kosongkan keranjang, segarkan stok. */
  const finishSale = useCallback(
    (sale: LastSale) => {
      setLastSale(sale)
      setItems([])
      setServices([])
      setTransactionDiscount(0)
      setPaying(false)
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
        // `direction` dan `label` sengaja TIDAK dikirim: keduanya ditentukan
        // katalog di server. Client tidak boleh menentukan arah uang.
        services: services.map((j) => ({
          kind: j.kind,
          providerId: j.providerId,
          passthroughAmount: j.passthroughAmount,
          serviceFeeAmount: j.serviceFeeAmount,
          ...(j.providerCostAmount > 0 ? { providerCostAmount: j.providerCostAmount } : {}),
          ...(j.customerRef ? { customerRef: j.customerRef } : {}),
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

      // Tidak ada lagi cabang PENDING di sini.
      //
      // Dengan QRIS soundbox, kasir menekan tombol QRIS SETELAH kotaknya
      // berbunyi — uangnya sudah masuk, jadi transaksinya langsung COMPLETED
      // lewat settleTransaction yang sama seperti tunai (docs/qris.md §3).
      //
      // Cabang PENDING-nya sendiri masih ada di server untuk provider dinamis
      // nanti; yang hilang cuma langkah kedua yang dulu harus ditekan manusia.

      if (result.providerBalances && result.providerBalances.length > 0) {
        // Saldo di rail ikut diperbarui, supaya kasir tidak menjual jasa
        // berikutnya berdasarkan angka yang sudah basi.
        void refreshProviders()
      }

      finishSale({
        trxNumber: result.trxNumber,
        transactionId: result.transactionId,
        changeAmount: result.changeAmount,
        negativeStock: result.negativeStock ?? [],
        providerBalances: result.providerBalances,
        replayed: result.replayed === true,
      })
    },
    [items, services, totals, transactionDiscount, finishSale, keyFor, refreshProviders],
  )

  // Dulu di sini ada confirmQris, cancelQris, dan refreshQrisStatus — tiga
  // fungsi untuk langkah kedua yang sekarang tidak ada.
  //
  // Endpoint-nya TIDAK ikut dihapus: /api/payments/:id/confirm dan /cancel
  // adalah jalur resmi pelunasan yang akan dipakai provider dinamis nanti lewat
  // webhook, dan keduanya masih dijaga state machine yang sama.

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
        {/* Kolom kiri dibagi dua: grid produk dan rail jasa, dipisahkan garis.
            Di layar sempit rail-nya pindah ke ATAS daftar produk — tetap
            terlihat, tetap satu ketukan, tidak bersembunyi di balik tab. */}
        <div className="flex min-h-0 flex-col-reverse gap-3 lg:flex-row">
          <div className="min-h-0 flex-1">
            <ProductPanel
              products={products}
              kategoriList={kategoriList}
              loading={loading}
              onSearch={search}
              onScan={handleScan}
              onPick={addToCart}
            />
          </div>
          <ServiceRail
            providers={providers}
            disabled={busy}
            onPick={(kind) => {
              setServiceKind(kind)
              setPayError(null)
            }}
          />
        </div>
        <CartPanel
          items={items}
          services={services}
          totals={totals}
          error={cartError}
          transactionDiscount={transactionDiscount}
          onQty={setQty}
          onRemove={removeItem}
          onRemoveService={removeService}
          onItemDiscount={setItemDiscount}
          onTransactionDiscount={setTransactionDiscount}
          onClear={clearCart}
          onPay={() => {
            setPayError(null)
            setPaying(true)
          }}
        />
      </div>

      {serviceKind && (
        <ServiceDialog
          kind={serviceKind}
          providers={providers}
          defaultFee={feeDefaults(serviceFees)[serviceKind]}
          onCancel={() => setServiceKind(null)}
          onAdd={addService}
        />
      )}

      {paying && totals && (
        <PaymentDialog
          // Yang harus ditutup uang pelanggan adalah uang yang BERPINDAH, bukan
          // omzet. Memakai netTotal di sini berarti kasir menerima Rp 2.500
          // untuk token Rp 100.000, dan kembaliannya dihitung dari angka salah.
          amount={totals.payAmount}
          payDirection={totals.payDirection}
          busy={busy}
          error={payError}
          qris={qris}
          onCancel={() => setPaying(false)}
          onPay={pay}
        />
      )}
    </div>
  )
}
