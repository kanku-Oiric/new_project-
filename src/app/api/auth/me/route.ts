import { ok, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

export const GET = route('auth.me', async () => {
  const user = await requireSession()
  return ok({ user })
})
