import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { cancelPayment } from '@/lib/payment/service'

export const dynamic = 'force-dynamic'

const CancelSchema = z.object({
  reason: z.string().trim().min(1).max(300).optional(),
})

/**
 * Batalkan pembayaran yang masih menunggu.
 *
 * Kasir boleh membatalkan tanpa PIN pemilik: tidak ada uang yang berpindah dan
 * tidak ada stok yang bergerak — transaksi PENDING belum pernah menyentuh
 * keduanya. Yang tercatat adalah siapa yang membatalkan, di audit log.
 */
export const POST = route(
  'payments.cancel',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession()
    const { id } = await ctx.params
    const body = await parseBody(req, CancelSchema)

    const result = await cancelPayment(
      id,
      {
        userId: session.id,
        role: session.role,
        ip: clientIp(req),
        deviceLabel: deviceLabel(req),
      },
      body.reason ?? 'Dibatalkan kasir di layar pembayaran',
    )

    return ok(result)
  },
)
