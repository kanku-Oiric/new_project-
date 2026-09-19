import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { findOpenShift, getShiftSummary } from '@/lib/shift/service'
import { ShiftClient, type OpenShiftInfo } from './shift-client'

export const dynamic = 'force-dynamic'

export default async function ShiftPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')

  const shift = await findOpenShift(session.id)
  const summary = shift ? await getShiftSummary(shift.id) : null

  const info: OpenShiftInfo | null = shift
    ? { id: shift.id, openedAt: shift.openedAt.toISOString(), openingCash: shift.openingCash }
    : null

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-lg p-4">
        <h1 className="mb-4 text-xl font-semibold text-kasir-text">Shift {session.name}</h1>
        <ShiftClient initialShift={info} initialSummary={summary} />
      </main>
    </>
  )
}
