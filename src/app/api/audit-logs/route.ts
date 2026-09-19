import { z } from 'zod'
import { ok, parseQuery, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  action: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

/**
 * Audit log — HANYA baca.
 *
 * Tidak ada PATCH maupun DELETE di file ini, dan tidak akan pernah ada. Kasir
 * tidak bisa menghapus jejak karena jalurnya memang tidak dibuat.
 */
export const GET = route('auditLogs.list', async (req) => {
  await requireRole('OWNER')
  const { action, limit } = parseQuery(req, QuerySchema)

  const logs = await prisma.auditLog.findMany({
    where: action ? { action } : {},
    orderBy: { at: 'desc' },
    take: limit,
  })
  return ok({ logs })
})
