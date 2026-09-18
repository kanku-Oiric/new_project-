import { clientIp, deviceLabel, ok, route } from '@/lib/api'
import { recordAuditSafe } from '@/lib/audit'
import { destroySession, getSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

export const POST = route('auth.logout', async (req) => {
  const session = await getSession()

  await destroySession()

  if (session) {
    await recordAuditSafe(
      {
        userId: session.id,
        role: session.role,
        ip: clientIp(req),
        deviceLabel: deviceLabel(req),
      },
      {
        action: 'LOGOUT',
        summary: `${session.name} logout`,
        entityType: 'User',
        entityId: session.id,
      },
    )
  }

  return ok({ ok: true })
})
