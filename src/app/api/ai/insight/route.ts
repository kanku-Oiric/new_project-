import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { recordAuditSafe } from '@/lib/audit'
import { requireRole } from '@/lib/auth/session'
import { requestInsight } from '@/lib/ai/service'
import { buildReport } from '@/lib/report/service'
import { assertPeriodKey } from '@/lib/schedule'

export const dynamic = 'force-dynamic'

/**
 * "Minta analisis" — satu-satunya jalan manusia memicu panggilan AI.
 *
 * Hanya mingguan dan bulanan; `kind` di skema ini memang tidak memuat DAILY,
 * jadi permintaan harian ditolak Zod sebelum menyentuh apa pun.
 *
 * Tanpa `refresh`, endpoint ini mengembalikan hasil TERSIMPAN kalau sudah ada —
 * tanpa memanggil API. Penting karena batasnya satu panggilan per hari: pemilik
 * yang membuka halaman ini lima kali tidak boleh kehilangan kuotanya.
 */
const InsightSchema = z.object({
  kind: z.enum(['WEEKLY', 'MONTHLY']),
  periodKey: z.string().min(1).max(20),
  refresh: z.boolean().optional(),
})

export const POST = route('ai.insight', async (req) => {
  const session = await requireRole('OWNER')
  const body = await parseBody(req, InsightSchema)
  assertPeriodKey(body.kind, body.periodKey)

  // Agregatnya dihitung di server dari database, bukan diterima dari client.
  // Client hanya menyebut periode mana.
  const built = await buildReport(body.kind, body.periodKey)

  const result = await requestInsight(
    {
      kind: body.kind,
      periodKey: body.periodKey,
      aggregate: built.aggregate,
      comparison: built.comparison,
    },
    {
      ...(body.refresh === undefined ? {} : { refresh: body.refresh }),
      requestedByUserId: session.id,
    },
  )

  // Dicatat apa pun hasilnya, termasuk saat AI mati. Pertanyaan "siapa yang
  // pernah mengirim data toko ke layanan luar, dan kapan" harus bisa dijawab.
  await recordAuditSafe(
    {
      userId: session.id,
      role: session.role,
      ip: clientIp(req),
      deviceLabel: deviceLabel(req),
    },
    {
      action: 'AI_INSIGHT_REQUEST',
      summary: `Analisis ${body.kind} ${body.periodKey}: ${result.status}`,
      entityType: 'AiInsight',
      after: {
        kind: body.kind,
        periodKey: body.periodKey,
        status: result.status,
        refresh: body.refresh === true,
        model: result.model,
      },
    },
  )

  return ok({
    status: result.status,
    message: result.message,
    text: result.text,
    model: result.model,
    createdAt: result.createdAt ? result.createdAt.toISOString() : null,
  })
})
