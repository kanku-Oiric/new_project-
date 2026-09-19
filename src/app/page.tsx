import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')

  // PIN bawaan dari seed tidak boleh terbawa ke toko. Selama belum diganti,
  // semua jalur masuk berujung di layar ganti PIN.
  if (session.mustChangePin) redirect('/ganti-pin')

  // Pemilik dan kasir membuka aplikasi ini untuk alasan yang berbeda: kasir untuk
  // berjualan, pemilik untuk melihat apa yang perlu diurus. Mengarahkan keduanya
  // ke layar kasir memaksa pemilik mencari, setiap kali.
  redirect(session.role === 'OWNER' ? '/dashboard' : '/kasir')
}
