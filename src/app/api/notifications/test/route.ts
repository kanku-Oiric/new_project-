import { z } from 'zod'
import { ok, parseBody, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { ReportChannelSchema } from '@/lib/enums'
import { ValidationError } from '@/lib/errors'
import { enqueue } from '@/lib/notify/queue'
import { notificationProviderFor } from '@/lib/notify/registry'
import { sendWithRetry } from '@/lib/notify/send'
import { getSetting } from '@/lib/settings'
import { formatClock } from '@/lib/time'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

const TestSchema = z.object({ channel: ReportChannelSchema })

/**
 * Kirim pesan uji ke satu saluran.
 *
 * Ini satu-satunya cara mengetahui sebuah saluran benar-benar bekerja. Selama
 * belum pernah ada kiriman yang sukses, UI hanya boleh mengatakan
 * "terkonfigurasi" — kredensial yang terisi tidak membuktikan apa pun tentang
 * webhook yang sudah dihapus pemiliknya dari server Discord.
 *
 * TIDAK menulis baris `report_deliveries`: ini bukan laporan, dan mencampurnya
 * akan mengotori riwayat pengiriman yang dipakai catch-up.
 */
export const POST = route('notifications.test', async (req) => {
  await requireRole('OWNER')
  const { channel } = await parseBody(req, TestSchema)

  const provider = notificationProviderFor(channel)
  const readiness = await provider.describe()
  if (!readiness.configured) {
    throw new ValidationError(
      [readiness.label, readiness.hint].filter(Boolean).join('. '),
    )
  }

  const now = new Date()
  const storeName = await getSetting('storeName')

  const outcome = await enqueue(() =>
    sendWithRetry(
      provider,
      {
        title: `Uji koneksi · ${storeName}`,
        periodLabel: `Dikirim ${formatClock(now, config.timezone)} WIB`,
        sections: [
          {
            label: 'Status',
            rows: [
              { label: 'Saluran', value: provider.name },
              { label: 'Hasil', value: 'Pesan ini berhasil dikirim dari sistem kasir' },
            ],
          },
        ],
        footnotes: ['Pesan uji. Tidak memuat angka penjualan dan tidak tercatat sebagai laporan.'],
      },
      // Sekali coba saja: pemilik sedang menunggu di depan layar, dan menunggu
      // lima percobaan dengan backoff hanya membuat tombolnya terasa rusak.
      { maxAttempts: 1 },
    ),
  )

  return ok({
    ok: outcome.ok,
    error: outcome.error,
    channel,
    sentAt: outcome.ok ? now.toISOString() : null,
  })
})
