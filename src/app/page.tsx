import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')

  // PIN bawaan dari seed tidak boleh terbawa ke toko. Selama belum diganti,
  // semua jalur masuk berujung di layar ganti PIN.
  if (session.mustChangePin) redirect('/ganti-pin')

  redirect('/kasir')
}
