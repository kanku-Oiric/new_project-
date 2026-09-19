import 'server-only'
import { recordAudit, type AuditActor } from '../audit'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { applyStockMovement } from '../db/stock'
import { NotFoundError, ValidationError } from '../errors'
import { ManualStockReasonSchema } from '../enums'
import { toBusinessDate } from '../time'

/**
 * Produk, barang masuk, dan penyesuaian stok.
 *
 * Referensi: docs/architecture.md §9.4
 */

export interface ProductActor extends AuditActor {
  userId: string
}

/** Kunci pencarian: lowercase gabungan nama + sku + barcode. */
export function buildSearchKey(p: { nama: string; sku: string; barcode: string | null }): string {
  return [p.nama, p.sku, p.barcode ?? ''].join(' ').toLowerCase().trim()
}

export interface ProductInput {
  sku: string
  barcode: string | null
  nama: string
  kategori: string
  hargaBeli: number
  hargaJual: number
  stokMinimum: number
  satuan: string
  aktif: boolean
}

function validatePrices(hargaBeli: number, hargaJual: number): void {
  if (!Number.isInteger(hargaBeli) || hargaBeli < 0) {
    throw new ValidationError('Harga beli harus bilangan bulat rupiah, minimal 0')
  }
  if (!Number.isInteger(hargaJual) || hargaJual < 0) {
    throw new ValidationError('Harga jual harus bilangan bulat rupiah, minimal 0')
  }
}

export async function createProduct(actor: ProductActor, input: ProductInput, stokAwal: number) {
  validatePrices(input.hargaBeli, input.hargaJual)
  if (!Number.isInteger(stokAwal) || stokAwal < 0) {
    throw new ValidationError('Stok awal harus bilangan bulat, minimal 0')
  }

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ...input,
        sku: input.sku.trim(),
        nama: input.nama.trim(),
        barcode: input.barcode?.trim() || null,
        searchKey: buildSearchKey(input),
        stok: 0,
      },
    })

    if (stokAwal > 0) {
      // Lewat applyStockMovement supaya invariant "stok == Σ qtyChange" berlaku
      // sejak baris pertama, bukan baru setelah transaksi pertama.
      await applyStockMovement(tx, {
        productId: product.id,
        qtyChange: stokAwal,
        reason: 'INITIAL',
        refType: 'MANUAL',
        userId: actor.userId,
        businessDate: toBusinessDate(new Date(), config.timezone),
        note: 'Stok awal saat produk dibuat',
      })
    }

    await recordAudit(tx, actor, {
      action: 'PRODUCT_CREATE',
      summary: `Produk ${product.nama} (${product.sku}) dibuat`,
      entityType: 'Product',
      entityId: product.id,
      after: { ...input, stokAwal },
    })

    return product
  })
}

/**
 * Ubah data produk.
 *
 * Perubahan harga dipisah menjadi dua action audit yang berbeda karena artinya
 * berbeda bagi pemilik: `PRICE_CHANGE` mempengaruhi harga yang dilihat
 * pelanggan, `COST_CHANGE` mempengaruhi laba kotor penjualan berikutnya.
 */
export async function updateProduct(
  actor: ProductActor,
  productId: string,
  input: Partial<ProductInput>,
) {
  if (input.hargaBeli !== undefined || input.hargaJual !== undefined) {
    validatePrices(input.hargaBeli ?? 0, input.hargaJual ?? 0)
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id: productId } })
    if (!before) throw new NotFoundError('Produk tidak ditemukan')

    const merged = {
      nama: input.nama?.trim() ?? before.nama,
      sku: input.sku?.trim() ?? before.sku,
      barcode: input.barcode === undefined ? before.barcode : input.barcode?.trim() || null,
    }

    const after = await tx.product.update({
      where: { id: productId },
      data: {
        ...input,
        ...merged,
        searchKey: buildSearchKey(merged),
      },
    })

    if (input.hargaJual !== undefined && input.hargaJual !== before.hargaJual) {
      await recordAudit(tx, actor, {
        action: 'PRICE_CHANGE',
        summary: `Harga jual ${after.nama}: ${before.hargaJual} → ${after.hargaJual}`,
        entityType: 'Product',
        entityId: productId,
        before: { hargaJual: before.hargaJual },
        after: { hargaJual: after.hargaJual },
      })
    }

    if (input.hargaBeli !== undefined && input.hargaBeli !== before.hargaBeli) {
      await recordAudit(tx, actor, {
        action: 'COST_CHANGE',
        summary: `Harga beli ${after.nama}: ${before.hargaBeli} → ${after.hargaBeli}`,
        entityType: 'Product',
        entityId: productId,
        before: { hargaBeli: before.hargaBeli },
        after: { hargaBeli: after.hargaBeli },
      })
    }

    await recordAudit(tx, actor, {
      action: 'PRODUCT_UPDATE',
      summary: `Produk ${after.nama} diubah`,
      entityType: 'Product',
      entityId: productId,
      before: { nama: before.nama, sku: before.sku, kategori: before.kategori, aktif: before.aktif },
      after: { nama: after.nama, sku: after.sku, kategori: after.kategori, aktif: after.aktif },
    })

    return after
  })
}

export interface StockInResult {
  productId: string
  stockBefore: number
  stockAfter: number
  hargaBeliChanged: boolean
}

/**
 * Barang masuk (restock).
 *
 * Reason `PURCHASE` dipisah dari `ADJUSTMENT` dan `OPNAME` dengan sengaja:
 * barang masuk karena beli adalah peristiwa yang berbeda dari barang yang
 * jumlahnya dikoreksi, dan laporan pergerakan stok harus tetap bisa dibaca.
 *
 * Yang TIDAK berubah saat `hargaBeli` diperbarui: HPP transaksi yang sudah
 * terjadi. `TransactionItem.unitCost` adalah snapshot, jadi memperbarui harga
 * beli tidak menulis ulang laba kotor bulan lalu. Ini titik paling mudah rusak
 * begitu restock jadi kegiatan rutin.
 */
export async function stockIn(
  actor: ProductActor,
  productId: string,
  qty: number,
  hargaBeli: number | undefined,
  note: string | undefined,
  now: Date = new Date(),
): Promise<StockInResult> {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new ValidationError('Jumlah barang masuk harus bilangan bulat, minimal 1')
  }
  if (hargaBeli !== undefined && (!Number.isInteger(hargaBeli) || hargaBeli < 0)) {
    throw new ValidationError('Harga beli harus bilangan bulat rupiah, minimal 0')
  }

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw new NotFoundError('Produk tidak ditemukan')

    const moved = await applyStockMovement(tx, {
      productId,
      qtyChange: qty,
      reason: 'PURCHASE',
      refType: 'PURCHASE',
      userId: actor.userId,
      businessDate: toBusinessDate(now, config.timezone),
      note: note?.trim() || undefined,
    })

    const hargaBeliChanged = hargaBeli !== undefined && hargaBeli !== product.hargaBeli

    if (hargaBeliChanged) {
      await tx.product.update({ where: { id: productId }, data: { hargaBeli } })
      await recordAudit(tx, actor, {
        action: 'COST_CHANGE',
        summary: `Harga beli ${product.nama}: ${product.hargaBeli} → ${hargaBeli} (barang masuk)`,
        entityType: 'Product',
        entityId: productId,
        before: { hargaBeli: product.hargaBeli },
        after: { hargaBeli },
      })
    }

    await recordAudit(tx, actor, {
      action: 'PURCHASE_RECEIVED',
      summary: `Barang masuk ${product.nama}: +${qty} (${moved.stockBefore} → ${moved.stockAfter})`,
      entityType: 'Product',
      entityId: productId,
      after: {
        qty,
        stockBefore: moved.stockBefore,
        stockAfter: moved.stockAfter,
        hargaBeli: hargaBeliChanged ? hargaBeli : product.hargaBeli,
        note: note ?? null,
      },
    })

    return {
      productId,
      stockBefore: moved.stockBefore,
      stockAfter: moved.stockAfter,
      hargaBeliChanged,
    }
  })
}

/** Penyesuaian stok manual: koreksi kesalahan (ADJUSTMENT) atau hasil hitung fisik (OPNAME). */
export async function adjustStock(
  actor: ProductActor,
  productId: string,
  input: { newQty?: number; qtyChange?: number; reason: string; note?: string },
  now: Date = new Date(),
) {
  const reason = ManualStockReasonSchema.parse(input.reason)

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw new NotFoundError('Produk tidak ditemukan')

    const qtyChange =
      input.qtyChange !== undefined ? input.qtyChange : (input.newQty ?? product.stok) - product.stok

    if (!Number.isInteger(qtyChange)) {
      throw new ValidationError('Perubahan stok harus bilangan bulat')
    }
    if (qtyChange === 0) {
      throw new ValidationError('Tidak ada perubahan stok yang perlu dicatat')
    }

    const moved = await applyStockMovement(tx, {
      productId,
      qtyChange,
      reason,
      refType: 'MANUAL',
      userId: actor.userId,
      businessDate: toBusinessDate(now, config.timezone),
      note: input.note?.trim() || undefined,
    })

    await recordAudit(tx, actor, {
      action: 'STOCK_ADJUSTMENT',
      summary: `${reason} ${product.nama}: ${moved.stockBefore} → ${moved.stockAfter} (${qtyChange > 0 ? '+' : ''}${qtyChange})`,
      entityType: 'Product',
      entityId: productId,
      before: { stok: moved.stockBefore },
      after: { stok: moved.stockAfter, reason, note: input.note ?? null },
    })

    return moved
  })
}
