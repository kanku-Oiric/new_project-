import { z } from 'zod'
import { ok, parseQuery, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { config } from '@/lib/config'
import { buildReport } from '@/lib/report/service'
import { periodKeyFor } from '@/lib/schedule'
import { toBusinessDate } from '@/lib/time'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'Format minggu harus YYYY-Www, mis. 2026-W38')
    .optional(),
})

export const GET = route('reports.weekly', async (req) => {
  await requireRole('OWNER')
  const { week } = parseQuery(req, QuerySchema)
  const periodKey = week ?? periodKeyFor('WEEKLY', toBusinessDate(new Date(), config.timezone))
  return ok(await buildReport('WEEKLY', periodKey))
})
