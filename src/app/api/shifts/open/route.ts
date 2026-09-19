import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { openShift } from '@/lib/shift/service'

export const dynamic = 'force-dynamic'

const OpenSchema = z.object({
  openingCash: z.number().int().min(0).max(2_147_483_647),
})

export const POST = route('shifts.open', async (req) => {
  const session = await requireSession()
  const { openingCash } = await parseBody(req, OpenSchema)

  const result = await openShift(
    { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
    openingCash,
  )
  return ok(result, 201)
})
