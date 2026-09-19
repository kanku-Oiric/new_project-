import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { ChangePinForm } from './change-pin-form'

export const dynamic = 'force-dynamic'

export default async function GantiPinPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <main className="mx-auto min-h-dvh w-full max-w-sm p-4">
      <h1 className="mb-1 text-xl font-semibold text-kasir-text">Ganti PIN</h1>
      <p className="mb-4 text-sm text-kasir-muted">{session.name}</p>

      {session.mustChangePin && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-kasir-warning">
          PIN kamu masih PIN bawaan dari seed. PIN itu tertulis di kode dan diketahui siapa pun yang
          pernah membaca repo ini — ganti sebelum sistem dipakai di toko.
        </p>
      )}

      <ChangePinForm mustChange={session.mustChangePin} />
    </main>
  )
}
