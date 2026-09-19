import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { verifyOwnerPin } from '@/lib/auth/login'
import { PinSchema } from '@/lib/auth/pin'
import { requireSession } from '@/lib/auth/session'
import { deleteExpense } from '@/lib/expense/service'

export const dynamic = 'force-dynamic'

const DeleteSchema = z.object({ ownerPin: PinSchema })

export const DELETE = route(
  'expenses.delete',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession()
    const { id } = await ctx.params
    const { ownerPin } = await parseBody(req, DeleteSchema)

    // PIN pemilik diverifikasi di SERVER, dan kena rate-limit yang sama seperti
    // login. Session kasir tidak pernah cukup untuk aksi ini.
    const authorizedByUserId = await verifyOwnerPin(ownerPin)

    await deleteExpense(
      {
        userId: session.id,
        role: session.role,
        authorizedByUserId,
        ip: clientIp(req),
        deviceLabel: deviceLabel(req),
      },
      id,
    )
    return ok({ ok: true })
  },
)
