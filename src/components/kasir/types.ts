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
