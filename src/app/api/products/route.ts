import { z } from 'zod'
import { ok, parseQuery, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  kategori: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
})

export interface ProductListItem {
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

/**
 * Daftar/pencarian produk untuk layar kasir.
 *
 * Pencarian memakai kolom `searchKey` (lowercase gabungan nama + sku + barcode)
 * dengan needle yang sudah di-lowercase. Prisma tidak mendukung
 * `mode: 'insensitive'` di SQLite, dan mengandalkan perilaku LIKE bawaan SQLite
 * hanya aman untuk ASCII — `searchKey` membuat hasilnya deterministik.
 *
 * `hargaBeli` TIDAK pernah dikirim ke client. Itu angka margin toko, dan layar
 * kasir dipakai karyawan di depan pelanggan.
 */
export const GET = route('products.list', async (req) => {
  await requireSession()
  const { q, kategori, limit } = parseQuery(req, QuerySchema)

  const needle = q?.toLowerCase()

  const products = await prisma.product.findMany({
    where: {
      aktif: true,
      ...(needle ? { searchKey: { contains: needle } } : {}),
      ...(kategori ? { kategori } : {}),
    },
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
    orderBy: { nama: 'asc' },
    take: limit,
  })

  const kategoriList = await prisma.product.findMany({
    where: { aktif: true },
    select: { kategori: true },
    distinct: ['kategori'],
    orderBy: { kategori: 'asc' },
  })

  return ok({
    products: products satisfies ProductListItem[],
    kategori: kategoriList.map((k) => k.kategori),
  })
})
