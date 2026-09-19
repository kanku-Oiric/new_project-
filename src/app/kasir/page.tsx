import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { KasirClient } from './kasir-client'

export const dynamic = 'force-dynamic'

const PRODUCT_FIELDS = {
  id: true,
  sku: true,
  barcode: true,
  nama: true,
  kategori: true,
  hargaJual: true,
  stok: true,
  stokMinimum: true,
  satuan: true,
} as const

export default async function KasirPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  // hargaBeli sengaja tidak ikut di select: layar kasir dipakai karyawan di
  // depan pelanggan, dan margin toko bukan konsumsi mereka.
  const [products, kategori] = await Promise.all([
    prisma.product.findMany({
      where: { aktif: true },
      select: PRODUCT_FIELDS,
      orderBy: { nama: 'asc' },
      take: 60,
    }),
    prisma.product.findMany({
      where: { aktif: true },
      select: { kategori: true },
      distinct: ['kategori'],
      orderBy: { kategori: 'asc' },
    }),
  ])

  return (
    <KasirClient
      initialProducts={products}
      initialKategori={kategori.map((k) => k.kategori)}
      cashierName={session.name}
    />
  )
}
