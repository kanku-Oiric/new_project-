import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { ProdukClient, type ProdukRow } from './produk-client'

export const dynamic = 'force-dynamic'

export default async function ProdukPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')
  if (session.role !== 'OWNER') redirect('/kasir')

  const products = await prisma.product.findMany({
    where: { aktif: true },
    orderBy: { nama: 'asc' },
    select: {
      id: true,
      sku: true,
      nama: true,
      kategori: true,
      hargaBeli: true,
      hargaJual: true,
      stok: true,
      stokMinimum: true,
      satuan: true,
    },
  })

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-2xl p-4">
        <h1 className="mb-1 text-xl font-semibold text-kasir-text">Produk</h1>
        <p className="mb-4 text-sm text-kasir-muted">
          Harga beli hanya terlihat di halaman ini, bukan di layar kasir.
        </p>
        <ProdukClient initialProducts={products satisfies ProdukRow[]} />
      </main>
    </>
  )
}
