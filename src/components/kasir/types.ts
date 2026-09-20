import type { ServiceDirection, ServiceKind } from '@/lib/enums'

/** Bentuk produk yang boleh sampai ke browser — tanpa hargaBeli. */
export interface KasirProduct {
  id: string
  sku: string
  barcode: string | null
  nama: string
  kategori: string
  hargaJual: number
  stok: number
  stokMinimum: number
  satuan: string
}

/** Satu baris di keranjang. */
export interface CartItem {
  productId: string
  nama: string
  sku: string
  satuan: string
  hargaJual: number
  /** Stok saat produk dimuat — untuk peringatan, bukan untuk memblokir. */
  stokTersedia: number
  qty: number
  itemDiscount: number
}

/** Provider beserta saldonya, seperti yang dilihat layar kasir. */
export interface KasirProvider {
  id: string
  nama: string
  jenis: string
  saldo: number
}

/**
 * Satu baris JASA di keranjang.
 *
 * `lineId` dibuat browser sebagai penomoran biasa, bukan UUID: dua baris jasa
 * yang isinya identik (dua pelanggan membeli token 100 ribu berturut-turut)
 * adalah dua baris yang sah, jadi keduanya butuh identitas sendiri di React.
 * Sengaja TIDAK memakai crypto.randomUUID — fungsi itu undefined di HP kasir
 * yang membuka http://192.168.x.x:3000 (lihat src/lib/idempotency.ts).
 */
export interface CartServiceItem {
  lineId: string
  kind: ServiceKind
  label: string
  direction: ServiceDirection
  providerId: string
  providerName: string
  /** Titipan yang diteruskan ke provider. Selalu positif. */
  passthroughAmount: number
  /** Biaya admin — pendapatan toko. */
  serviceFeeAmount: number
  /** Potongan provider ke toko, kalau ada. */
  providerCostAmount: number
  customerRef?: string
}
