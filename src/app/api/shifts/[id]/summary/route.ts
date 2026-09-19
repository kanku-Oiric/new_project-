import { ok, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { getShiftSummary } from '@/lib/shift/service'

export const dynamic = 'force-dynamic'

export const GET = route(
  'shifts.summary',
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireSession()
    const { id } = await ctx.params
    return ok({ summary: await getShiftSummary(id) })
  },
)
