import { z } from 'zod'
import { ok, parseQuery, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  barcode: z.string().trim().min(1).max(64),
})

/**
 * Lookup satu produk berdasarkan barcode — jalur cepat untuk scanner.
 *
 * Dipisah dari pencarian umum karena perilakunya harus berbeda: scanner
 * mengirim kode persis dan menekan Enter, jadi yang dibutuhkan adalah kecocokan
 * TEPAT dan satu hasil. Pencarian parsial di jalur ini akan membuat scan
 * "899000" menambahkan barang yang salah ke keranjang.
 */
export const GET = route('products.lookup', async (req) => {
  await requireSession()
  const { barcode } = parseQuery(req, QuerySchema)

  const product = await prisma.product.findFirst({
    where: { barcode, aktif: true },
    select: {
      id: true,
      sku: true,
      barcode: true,
      nama: true,
      kategori: true,
      hargaJual: true,
      stok: true,
      stokMinimum: true,
      satuan: true,
    },
  })

  if (!product) {
    // Fallback ke SKU: banyak toko menempel label SKU sendiri untuk barang
    // curah yang tidak punya barcode pabrik.
    const bySku = await prisma.product.findFirst({
      where: { sku: barcode, aktif: true },
      select: {
        id: true,
        sku: true,
        barcode: true,
        nama: true,
        kategori: true,
        hargaJual: true,
        stok: true,
        stokMinimum: true,
        satuan: true,
      },
    })
    if (!bySku) throw new NotFoundError(`Barcode tidak dikenal: ${barcode}`)
    return ok({ product: bySku })
  }

  return ok({ product })
})
