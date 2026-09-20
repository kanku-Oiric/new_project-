import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { verifyOwnerPin } from '@/lib/auth/login'
import { PinSchema } from '@/lib/auth/pin'
import { requireRole } from '@/lib/auth/session'
import { IdempotencyKeySchema } from '@/lib/idempotency'
import { adjustProviderBalance } from '@/lib/provider/service'

export const dynamic = 'force-dynamic'

const AdjustSchema = z.object({
  /** Saldo ASLI yang dibaca pemilik di aplikasi provider. */
  newBalance: z.number().int().min(-2_147_483_647).max(2_147_483_647),
  reason: z.string().trim().min(3, 'Alasan penyesuaian wajib diisi').max(300),
  ownerPin: PinSchema,
  idempotencyKey: IdempotencyKeySchema,
})

/**
 * Sesuaikan saldo tercatat terhadap saldo asli di aplikasi provider.
 *
 * Setara opname untuk stok, tapi taruhannya uang — dan tidak ada bukti di dalam
 * sistem yang bisa membenarkan angkanya, karena buktinya ada di layar aplikasi
 * Shopee. Karena itu ia minta PIN pemilik SETIAP kali, bukan mengandalkan
 * session yang kebetulan sedang login sebagai pemilik.
 */
export const POST = route(
  'providers.adjustment',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireRole('OWNER')
    const { id } = await ctx.params
    const body = await parseBody(req, AdjustSchema)

    const authorizedByUserId = await verifyOwnerPin(body.ownerPin)

    const result = await adjustProviderBalance(
      {
        userId: session.id,
        role: session.role,
        authorizedByUserId,
        ip: clientIp(req),
        deviceLabel: deviceLabel(req),
      },
      id,
      { newBalance: body.newBalance, note: body.reason, idempotencyKey: body.idempotencyKey },
    )

    return ok(result, result.replayed ? 200 : 201)
  },
)
