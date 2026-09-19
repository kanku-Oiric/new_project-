import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { recordAudit } from '@/lib/audit'
import { requireRole } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { ReportChannelSchema, ReportKindSchema } from '@/lib/enums'
import { ValidationError } from '@/lib/errors'
import { enqueue } from '@/lib/notify/queue'
import { configuredChannels } from '@/lib/notify/registry'
import { deliverReport } from '@/lib/report/service'
import { assertPeriodKey } from '@/lib/schedule'

export const dynamic = 'force-dynamic'

const SendSchema = z.object({
  kind: ReportKindSchema,
  periodKey: z.string().min(1).max(20),
  channels: z.array(ReportChannelSchema).min(1).optional(),
})

/**
 * Kirim laporan sekarang — pengiriman MANUAL.
 *
 * Bedanya dengan catch-up bukan cuma siapa yang memicunya:
 *  - boleh mengirim periode yang BELUM selesai (laporan hari ini jam 15:00),
 *  - boleh diulang sebanyak yang diminta,
 *  - TIDAK menandai periode itu sudah terkirim, sehingga laporan penuh hari itu
 *    tetap dikirim otomatis setelah harinya berakhir (docs/reporting.md §6.3).
 *
 * Pemanggil menunggu hasilnya supaya pemilik melihat berhasil atau gagalnya,
 * tapi pengirimannya tetap lewat antrean yang sama dengan catch-up — dua
 * pengiriman tidak pernah menembak webhook bersamaan.
 */
export const POST = route('reports.send', async (req) => {
  const session = await requireRole('OWNER')
  const body = await parseBody(req, SendSchema)
  assertPeriodKey(body.kind, body.periodKey)

  const available = await configuredChannels()
  const channels = body.channels ?? available

  if (channels.length === 0) {
    // Tidak berpura-pura terkirim. Kalau tidak ada tujuan, itu yang dikatakan.
    throw new ValidationError(
      'Belum ada saluran notifikasi yang dikonfigurasi. Isi webhook Discord atau token Telegram di Pengaturan.',
    )
  }

  const belumSiap = channels.filter((c) => !available.includes(c))
  if (belumSiap.length > 0) {
    throw new ValidationError(`Saluran belum dikonfigurasi: ${belumSiap.join(', ')}`)
  }

  const results = []
  for (const channel of channels) {
    results.push(
      await enqueue(() =>
        deliverReport(body.kind, body.periodKey, channel, 'MANUAL', {
          requestedByUserId: session.id,
        }),
      ),
    )
  }

  await recordAudit(
    prisma,
    {
      userId: session.id,
      role: session.role,
      ip: clientIp(req),
      deviceLabel: deviceLabel(req),
    },
    {
      action: 'REPORT_SEND_MANUAL',
      summary: `Kirim manual laporan ${body.kind} ${body.periodKey} ke ${channels.join(', ')}`,
      entityType: 'ReportDelivery',
      after: {
        kind: body.kind,
        periodKey: body.periodKey,
        hasil: results.map((r) => ({ channel: r.channel, status: r.status, error: r.error })),
      },
    },
  )

  return ok({ results })
})
