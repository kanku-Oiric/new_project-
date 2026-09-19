import { z } from 'zod'
import { ok, parseQuery, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { DeliveryStatusSchema, ReportTriggerSchema, type ReportChannel } from '@/lib/enums'
import { listNotificationProviders } from '@/lib/notify/registry'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  status: DeliveryStatusSchema.optional(),
  trigger: ReportTriggerSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * Daftar pengiriman + keadaan tiap saluran.
 *
 * Status saluran disusun dari KENYATAAN, bukan klaim: "terkonfigurasi" hanya
 * berarti kredensialnya terisi, dan "terakhir berhasil" diambil dari baris
 * pengiriman yang benar-benar SENT. Tidak ada keadaan bernama "tersambung"
 * (docs/architecture.md §11).
 */
export const GET = route('reports.deliveries', async (req) => {
  await requireRole('OWNER')
  const query = parseQuery(req, QuerySchema)

  const [rows, providers] = await Promise.all([
    prisma.reportDelivery.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.trigger ? { trigger: query.trigger } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    }),
    Promise.resolve(listNotificationProviders()),
  ])

  const channels = await Promise.all(
    providers.map(async (p) => {
      const readiness = await p.describe()
      const lastSent = await prisma.reportDelivery.findFirst({
        where: { channel: p.channel, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true, kind: true, periodKey: true },
      })
      const lastFailed = await prisma.reportDelivery.findFirst({
        where: { channel: p.channel, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        select: { lastError: true, createdAt: true },
      })

      return {
        channel: p.channel as ReportChannel,
        name: p.name,
        configured: readiness.configured,
        label: readiness.label,
        hint: readiness.hint,
        lastSentAt: lastSent?.sentAt ?? null,
        lastSentPeriod: lastSent ? `${lastSent.kind} ${lastSent.periodKey}` : null,
        lastError: lastFailed?.lastError ?? null,
        lastErrorAt: lastFailed?.createdAt ?? null,
      }
    }),
  )

  return ok({ deliveries: rows, channels })
})
