import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, parseQuery, route } from '@/lib/api'
import { requireRole, requireSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { createProduct } from '@/lib/product/service'

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

const CreateSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  barcode: z.string().trim().max(40).nullable().default(null),
  nama: z.string().trim().min(1).max(120),
  kategori: z.string().trim().min(1).max(60),
  hargaBeli: z.number().int().min(0).max(2_147_483_647),
  hargaJual: z.number().int().min(0).max(2_147_483_647),
  stokMinimum: z.number().int().min(0).max(1_000_000).default(0),
  satuan: z.string().trim().min(1).max(20).default('pcs'),
  stokAwal: z.number().int().min(0).max(1_000_000).default(0),
})

/**
 * Tambah produk — pemilik saja, ditegakkan SERVER.
 *
 * Menyembunyikan tombol di layar bukan otorisasi (docs/architecture.md §7.3):
 * siapa pun di WiFi toko bisa memanggil endpoint ini dengan `curl`, dan produk
 * baru membawa harga jual — angka yang langsung menentukan uang masuk.
 *
 * Stok awal masuk lewat `applyStockMovement` di dalam service, bukan ditulis
 * langsung ke kolom `stok`, supaya invarian "stok == Σ qtyChange" berlaku sejak
 * baris pertama.
 */
export const POST = route('products.create', async (req) => {
  const session = await requireRole('OWNER')
  const body = await parseBody(req, CreateSchema)

  const { stokAwal, ...input } = body

  const product = await createProduct(
    { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
    { ...input, aktif: true },
    stokAwal,
  )

  return ok({ product }, 201)
})
