import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { closeShift } from '@/lib/shift/service'

export const dynamic = 'force-dynamic'

const CloseSchema = z.object({
  countedCash: z.number().int().min(0).max(2_147_483_647),
  notes: z.string().trim().max(500).optional(),
})

export const POST = route(
  'shifts.close',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession()
    const { id } = await ctx.params
    const body = await parseBody(req, CloseSchema)

    const result = await closeShift(
      { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
      id,
      body.countedCash,
      body.notes ?? null,
    )
    return ok(result)
  },
)
