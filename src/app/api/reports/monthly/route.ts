import { z } from 'zod'
import { ok, parseQuery, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { config } from '@/lib/config'
import { buildReport } from '@/lib/report/service'
import { periodKeyFor } from '@/lib/schedule'
import { toBusinessDate } from '@/lib/time'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Format bulan harus YYYY-MM')
    .optional(),
})

export const GET = route('reports.monthly', async (req) => {
  await requireRole('OWNER')
  const { month } = parseQuery(req, QuerySchema)
  const periodKey = month ?? periodKeyFor('MONTHLY', toBusinessDate(new Date(), config.timezone))
  return ok(await buildReport('MONTHLY', periodKey))
})
