import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')

  // Sesuai docs/architecture.md §14. Pemilik seharusnya menuju /dashboard,
  // tapi halaman itu baru ada di Fase 7 — sampai saat itu keduanya ke kasir,
  // karena pemilik pun berjualan.
  redirect('/kasir')
}
