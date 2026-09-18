import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { login } from '@/lib/auth/login'
import { PinSchema } from '@/lib/auth/pin'

export const dynamic = 'force-dynamic'

const LoginSchema = z.object({
  userId: z.string().uuid('User tidak valid'),
  pin: PinSchema,
})

export const POST = route('auth.login', async (req) => {
  const body = await parseBody(req, LoginSchema)

  const user = await login(body.userId, body.pin, {
    ip: clientIp(req),
    deviceLabel: deviceLabel(req),
  })

  return ok({ user })
})
