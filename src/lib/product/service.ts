import 'server-only'
import { recordAudit, type AuditActor } from '../audit'
import { config } from '../config'
import { isUniqueViolation } from '../db/errors'
import { prisma } from '../db/prisma'
import { applyStockMovement, type StockMovementResult } from '../db/stock'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { ManualStockReasonSchema, type ManualStockReason } from '../enums'
import { fingerprint } from '../idempotency-server'
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

export interface StockInInput {
  qty: number
  hargaBeli?: number
  note?: string
  /**
   * Kunci sekali-pakai (src/lib/idempotency.ts). WAJIB.
   *
   * Barang masuk yang tercatat dua kali menaikkan stok dua kali, dan selisihnya
   * baru ketahuan saat hitung fisik berikutnya — bisa berminggu-minggu kemudian,
   * saat tidak ada lagi yang ingat request mana yang diulang.
   */
  idempotencyKey: string
}

export interface StockInResult {
  productId: string
  stockBefore: number
  stockAfter: number
  hargaBeliChanged: boolean
  /** `true` = barang masuk ini sudah tercatat sebelumnya; stok tidak naik dua kali. */
  replayed: boolean
}

export interface AdjustStockInput {
  newQty?: number
  qtyChange?: number
  reason: string
  note?: string
  /** Kunci sekali-pakai (src/lib/idempotency.ts). WAJIB. */
  idempotencyKey: string
}

export interface AdjustStockResult extends StockMovementResult {
  /** `true` = penyesuaian ini sudah tercatat sebelumnya; koreksinya tidak berlaku dua kali. */
  replayed: boolean
}

/**
 * Argumennya objek, bukan parameter berjejer.
 *
 * `note` dan `idempotencyKey` dua-duanya `string`, dan TypeScript tidak akan
 * menangkap kalau keduanya tertukar di satu pemanggilan — yang tersimpan akan
 * jadi catatan berisi UUID dan kunci berisi "Kiriman pemasok", tanpa satu pun
 * pemeriksaan yang gagal.
 */
function requireKey(key: string, operasi: string): void {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ValidationError(`idempotencyKey wajib diisi untuk ${operasi}`)
  }
}

/**
 * Sidik jari barang masuk.
 *
 * `kind` ikut karena barang masuk dan penyesuaian stok BERBAGI satu kolom kunci
 * di tabel `stock_movements`: tanpa pembeda, satu kunci bisa dipakai untuk
 * barang masuk lalu dijawab dengan penyesuaian yang kebetulan angkanya sama.
 */
function stockInFingerprint(productId: string, input: StockInInput): string {
  return fingerprint({
    kind: 'STOCK_IN',
    productId,
    qty: input.qty,
    hargaBeli: input.hargaBeli ?? null,
    note: input.note?.trim() || null,
  })
}

/** Sidik jari penyesuaian stok. */
function adjustFingerprint(productId: string, input: AdjustStockInput): string {
  return fingerprint({
    kind: 'STOCK_ADJUSTMENT',
    productId,
    // Angka MENTAH dari client, bukan `qtyChange` hasil hitungan.
    //
    // `newQty` dikonversi menjadi selisih terhadap stok SAAT ITU. Sidik jari yang
    // memakai hasil konversinya akan berubah setiap kali stok bergerak, sehingga
    // pengulangan yang sah — request yang sama persis, dikirim ulang karena
    // response-nya hilang — dijawab 409 "kunci dipakai untuk isi berbeda".
    newQty: input.newQty ?? null,
    qtyChange: input.qtyChange ?? null,
    reason: input.reason,
    note: input.note?.trim() || null,
  })
}

/**
 * Baca pergerakan stok yang kuncinya sudah pernah dipakai. `null` = belum pernah.
 *
 * Dua penolakan, keduanya 409 dan keduanya sengaja TIDAK dijawab dengan data:
 * sidik jari berbeda berarti kuncinya dipakai untuk operasi lain, dan pemilik
 * kunci yang berbeda berarti kuncinya milik orang lain.
 */
async function readMovementByKey(
  key: string,
  expectedFingerprint: string,
  actorUserId: string,
) {
  const movement = await prisma.stockMovement.findUnique({ where: { idempotencyKey: key } })
  if (!movement) return null

  if (movement.idempotencyFingerprint !== expectedFingerprint) {
    throw new ConflictError(
      'Kunci ini sudah dipakai untuk pergerakan stok yang berbeda. Muat ulang halaman produk sebelum mengulang.',
    )
  }
  if (movement.userId !== actorUserId) {
    throw new ConflictError('Kunci pergerakan stok ini milik pengguna lain.')
  }
  return movement
}

function stockInReplay(
  productId: string,
  movement: { stockBefore: number; stockAfter: number },
): StockInResult {
  return {
    productId,
    stockBefore: movement.stockBefore,
    stockAfter: movement.stockAfter,
    // `false` dengan sengaja: yang dijawab adalah "request INI tidak mengubah apa
    // pun". Perubahan harga beli aslinya tercatat di audit log sebagai
    // COST_CHANGE dan harga sekarang terlihat di halaman produk, jadi tidak ada
    // informasi yang hilang — sementara menjawab `true` berarti mengaku baru saja
    // mengubah harga padahal tidak ada yang berubah.
    hargaBeliChanged: false,
    replayed: true,
  }
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
  input: StockInInput,
  now: Date = new Date(),
): Promise<StockInResult> {
  const { qty, hargaBeli } = input

  if (!Number.isInteger(qty) || qty < 1) {
    throw new ValidationError('Jumlah barang masuk harus bilangan bulat, minimal 1')
  }
  if (hargaBeli !== undefined && (!Number.isInteger(hargaBeli) || hargaBeli < 0)) {
    throw new ValidationError('Harga beli harus bilangan bulat rupiah, minimal 0')
  }
  // Lapis kedua setelah Zod di route.
  requireKey(input.idempotencyKey, 'mencatat barang masuk')

  const print = stockInFingerprint(productId, input)

  const sudahAda = await readMovementByKey(input.idempotencyKey, print, actor.userId)
  if (sudahAda) return stockInReplay(productId, sudahAda)

  try {
    return await stockInInTx(actor, productId, input, print, now)
  } catch (e) {
    // Dua request serentak dengan kunci yang sama: indeks unique di DATABASE yang
    // menentukan pemenangnya, dan yang kalah membaca hasil pemenang.
    if (isUniqueViolation(e)) {
      const lagi = await readMovementByKey(input.idempotencyKey, print, actor.userId)
      if (lagi) return stockInReplay(productId, lagi)
    }
    throw e
  }
}

async function stockInInTx(
  actor: ProductActor,
  productId: string,
  input: StockInInput,
  print: string,
  now: Date,
): Promise<StockInResult> {
  const { qty, hargaBeli, note } = input

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
      // Kuncinya menempel pada BARIS pergerakan stok, di dalam transaction yang
      // sama seperti kenaikan stok dan perubahan harga beli. Kalau kuncinya
      // bentrok, insert ini gagal dan seluruh transaction di-rollback — stok
      // tidak mungkin naik tanpa kunci yang menjaganya.
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: print,
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
      replayed: false,
    }
  })
}

/** Penyesuaian stok manual: koreksi kesalahan (ADJUSTMENT) atau hasil hitung fisik (OPNAME). */
export async function adjustStock(
  actor: ProductActor,
  productId: string,
  input: AdjustStockInput,
  now: Date = new Date(),
): Promise<AdjustStockResult> {
  const reason = ManualStockReasonSchema.parse(input.reason)
  requireKey(input.idempotencyKey, 'mencatat penyesuaian stok')

  const print = adjustFingerprint(productId, { ...input, reason })

  const sudahAda = await readMovementByKey(input.idempotencyKey, print, actor.userId)
  if (sudahAda) {
    return {
      productId,
      stockBefore: sudahAda.stockBefore,
      stockAfter: sudahAda.stockAfter,
      qtyChange: sudahAda.qtyChange,
      replayed: true,
    }
  }

  try {
    return await adjustStockInTx(actor, productId, input, reason, print, now)
  } catch (e) {
    if (isUniqueViolation(e)) {
      const lagi = await readMovementByKey(input.idempotencyKey, print, actor.userId)
      if (lagi) {
        return {
          productId,
          stockBefore: lagi.stockBefore,
          stockAfter: lagi.stockAfter,
          qtyChange: lagi.qtyChange,
          replayed: true,
        }
      }
    }
    throw e
  }
}

async function adjustStockInTx(
  actor: ProductActor,
  productId: string,
  input: AdjustStockInput,
  reason: ManualStockReason,
  print: string,
  now: Date,
): Promise<AdjustStockResult> {
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
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: print,
    })

    await recordAudit(tx, actor, {
      action: 'STOCK_ADJUSTMENT',
      summary: `${reason} ${product.nama}: ${moved.stockBefore} → ${moved.stockAfter} (${qtyChange > 0 ? '+' : ''}${qtyChange})`,
      entityType: 'Product',
      entityId: productId,
      before: { stok: moved.stockBefore },
      after: { stok: moved.stockAfter, reason, note: input.note ?? null },
    })

    return { ...moved, replayed: false }
  })
}
