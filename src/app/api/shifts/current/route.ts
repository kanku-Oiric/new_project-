import { ok, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { findOpenShift, getShiftSummary } from '@/lib/shift/service'

export const dynamic = 'force-dynamic'

export const GET = route('shifts.current', async () => {
  const session = await requireSession()
  const shift = await findOpenShift(session.id)
  if (!shift) return ok({ shift: null, summary: null })

  return ok({ shift, summary: await getShiftSummary(shift.id) })
})
