import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { listServiceProviders } from '@/lib/provider/service'
import { SaldoClient } from './saldo-client'

export const dynamic = 'force-dynamic'

/**
 * Saldo provider — akun uang yang duduk di aplikasi Shopee/GoPay milik toko.
 *
 * Pemilik saja. Bukan karena kasir tidak boleh tahu saldonya (layar kasir justru
 * menampilkannya di rail jasa), tapi karena halaman ini bisa MENGUBAH angka
 * uang: mengisi saldo dari laci, dan menyesuaikan angka tercatat terhadap angka
 * asli di aplikasinya.
 */
export default async function SaldoPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')
  if (session.role !== 'OWNER') redirect('/kasir')

  const providers = await listServiceProviders(true)

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-2xl p-4">
        <h1 className="mb-1 text-xl font-semibold text-kasir-text">Saldo provider</h1>
        <p className="mb-4 text-sm text-kasir-muted">
          Uang yang ada di aplikasi Shopee/GoPay/bank milik toko — terpisah dari laci kas.
          Mengisi saldo dari laci <strong>bukan pengeluaran</strong>: uangnya hanya pindah
          kantong, jadi ia tidak mengurangi laba, tapi memang mengurangi uang di laci.
        </p>
        <SaldoClient initialProviders={providers} />
      </main>
    </>
  )
}
