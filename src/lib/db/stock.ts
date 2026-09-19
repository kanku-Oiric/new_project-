import type { Prisma } from '@prisma/client'
import type { StockReason, StockRefType } from '../enums'
import { ConflictError } from '../errors'

/**
 * Pergerakan stok.
 *
 * Ini SATU-SATUNYA jalan `products.stok` boleh berubah. Tidak ada UPDATE stok
 * langsung di tempat lain, sehingga setiap perubahan pasti meninggalkan jejak
 * di `stock_movements` (docs/architecture.md §3.1 aturan 7).
 */

export interface StockMovementInput {
  productId: string
  /** BERTANDA: negatif = keluar (penjualan), positif = masuk (refund/restock). */
  qtyChange: number
  reason: StockReason
  userId: string
  businessDate: string
  refType?: StockRefType
  refId?: string
  note?: string
}

export interface StockMovementResult {
  productId: string
  stockBefore: number
  stockAfter: number
  qtyChange: number
}

/**
 * Kurangi/tambah stok secara ATOMIC lalu catat pergerakannya.
 *
 * Pengurangan dilakukan lewat raw SQL `SET stok = stok + ?`, bukan baca-lalu-
 * tulis. Ini koreksi bug, bukan preferensi gaya:
 *
 *   Kasir A: baca stok=10 → hitung 10−1=9 → tulis 9
 *   Kasir B: baca stok=10 → hitung 10−1=9 → tulis 9   ← update A HILANG
 *   Hasil: 2 barang terjual, stok cuma turun 1
 *
 * Alasannya tetap berlaku walaupun stok minus diizinkan — masalahnya bukan
 * pengecekan batas, melainkan lost update.
 *
 * `updatedAt` sengaja TIDAK disentuh di sini: kolom itu menandai perubahan data
 * produk (harga, nama), sedangkan riwayat stok sudah punya tabelnya sendiri.
 * Menyetelnya lewat raw SQL juga akan mengikat kita pada cara Prisma
 * menyimpan DateTime di SQLite.
 */
export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  input: StockMovementInput,
): Promise<StockMovementResult> {
  if (!Number.isInteger(input.qtyChange) || input.qtyChange === 0) {
    throw new Error(`qtyChange harus bilangan bulat bukan nol, dapat ${input.qtyChange}`)
  }

  const rows = await tx.$queryRaw<{ stok: number | bigint }[]>`
    UPDATE products SET stok = stok + ${input.qtyChange}
    WHERE id = ${input.productId}
    RETURNING stok
  `

  const row = rows[0]
  if (!row) {
    // Produk hilang di tengah transaksi (dihapus/di-nonaktifkan bersamaan).
    // Melempar di sini akan me-rollback seluruh checkout, yang memang benar.
    throw new ConflictError('Produk tidak ditemukan saat memperbarui stok')
  }

  // SQLite mengembalikan integer sebagai BigInt lewat Prisma raw query.
  const stockAfter = Number(row.stok)
  const stockBefore = stockAfter - input.qtyChange

  await tx.stockMovement.create({
    data: {
      productId: input.productId,
      qtyChange: input.qtyChange,
      reason: input.reason,
      stockBefore,
      stockAfter,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      userId: input.userId,
      note: input.note ?? null,
      businessDate: input.businessDate,
    },
  })

  return { productId: input.productId, stockBefore, stockAfter, qtyChange: input.qtyChange }
}
