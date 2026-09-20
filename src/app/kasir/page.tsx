import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { providerForMethod } from '@/lib/payment/registry'
import { listServiceProviders } from '@/lib/provider/service'
import { getSetting } from '@/lib/settings'
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
  // Gerbang PIN seed juga berlaku di layar kasir. Tanpa baris ini, kasir bisa
  // berjualan sepanjang hari dengan PIN bawaan yang tertulis di dokumentasi.
  if (session.mustChangePin) redirect('/ganti-pin')

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

  // Keadaan QRIS dibaca dari providernya, bukan ditebak dari setting di sini.
  // Satu sumber kalimat berarti layar kasir tidak bisa mengklaim lebih dari yang
  // sebenarnya aktif (docs/qris.md §3.2).
  const qrisProvider = providerForMethod('QRIS_STATIC')
  const [qrisReadiness, providers, serviceFees] = await Promise.all([
    qrisProvider.describe(),
    listServiceProviders(),
    getSetting('serviceFeeDefaults'),
  ])

  return (
    <KasirClient
      initialProducts={products}
      initialKategori={kategori.map((k) => k.kategori)}
      initialProviders={providers.map((p) => ({
        id: p.id,
        nama: p.nama,
        jenis: p.jenis,
        saldo: p.saldo,
      }))}
      serviceFees={serviceFees}
      cashierName={session.name}
      role={session.role}
      qris={{
        configured: qrisReadiness.configured,
        label: qrisReadiness.label,
        hint: qrisReadiness.hint,
      }}
    />
  )
}
