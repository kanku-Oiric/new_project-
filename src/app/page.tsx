import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')

  // Fase 1 belum punya /kasir dan /dashboard. Sampai Fase 2 mendarat, keduanya
  // mengarah ke halaman sambutan yang menampilkan status login.
  redirect('/beranda')
}
