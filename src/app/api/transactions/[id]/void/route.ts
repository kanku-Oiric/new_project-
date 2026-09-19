import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { verifyOwnerPin } from '@/lib/auth/login'
import { PinSchema } from '@/lib/auth/pin'
import { requireSession } from '@/lib/auth/session'
import { voidTransaction } from '@/lib/transaction/service'

export const dynamic = 'force-dynamic'

const VoidSchema = z.object({
  ownerPin: PinSchema,
  reason: z.string().trim().min(3, 'Alasan pembatalan wajib diisi').max(300),
})

export const POST = route(
  'transactions.void',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession()
    const { id } = await ctx.params
    const body = await parseBody(req, VoidSchema)

    // Diverifikasi di server, kena rate-limit login. Kasir yang meninggalkan
    // device dalam keadaan login tidak otomatis memberi akses pemilik.
    const authorizedByUserId = await verifyOwnerPin(body.ownerPin)

    const result = await voidTransaction(
      {
        userId: session.id,
        role: session.role,
        authorizedByUserId,
        ip: clientIp(req),
        deviceLabel: deviceLabel(req),
      },
      id,
      body.reason,
    )
    return ok(result)
  },
)
