import { z } from 'zod'
import { ok, parseBody, route } from '@/lib/api'
import { changeOwnPin } from '@/lib/auth/change-pin'
import { PinSchema } from '@/lib/auth/pin'
import { requireSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

const ChangeSchema = z.object({
  currentPin: PinSchema,
  newPin: PinSchema,
})

export const POST = route('auth.changePin', async (req) => {
  const session = await requireSession()
  const body = await parseBody(req, ChangeSchema)

  await changeOwnPin(
    { userId: session.id, role: session.role, name: session.name },
    body.currentPin,
    body.newPin,
  )
  return ok({ ok: true })
})
