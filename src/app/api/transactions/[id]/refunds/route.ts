import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { verifyOwnerPin } from '@/lib/auth/login'
import { PinSchema } from '@/lib/auth/pin'
import { requireSession } from '@/lib/auth/session'
import { RefundMethodSchema } from '@/lib/enums'
import { ConflictError } from '@/lib/errors'
import { IdempotencyKeySchema } from '@/lib/idempotency'
import { findOpenShift } from '@/lib/shift/service'
import { createRefund } from '@/lib/transaction/service'

export const dynamic = 'force-dynamic'

const RefundSchema = z.object({
  ownerPin: PinSchema,
  items: z
    .array(
      z.object({
        transactionItemId: z.string().uuid(),
        qty: z.number().int().min(1).max(10_000),
      }),
    )
    .min(1, 'Pilih minimal satu item untuk di-refund'),
  method: RefundMethodSchema.default('CASH'),
  reason: z.string().trim().min(3, 'Alasan refund wajib diisi').max(300),
  // Refund sebagian yang diulang karena response hilang akan lolos guard
  // kumulatif (1 dari 3, lalu 1 dari 3 lagi = 2 terkembalikan). Kunci ini yang
  // menahannya (src/lib/idempotency.ts).
  idempotencyKey: IdempotencyKeySchema.optional(),
})

export const POST = route(
  'transactions.refund',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession()
    const { id } = await ctx.params
    const body = await parseBody(req, RefundSchema)

    const authorizedByUserId = await verifyOwnerPin(body.ownerPin)

    // Refund dibebankan ke shift tempat refund TERJADI, bukan shift penjualan
    // asal — kalau tidak, uang keluar membebani laci yang sudah direkonsiliasi.
    const shift = await findOpenShift(session.id)
    if (!shift) {
      throw new ConflictError('Belum ada shift terbuka. Buka shift dulu sebelum melakukan refund.')
    }

    const result = await createRefund(
      {
        userId: session.id,
        role: session.role,
        authorizedByUserId,
        ip: clientIp(req),
        deviceLabel: deviceLabel(req),
      },
      id,
      shift.id,
      body.items,
      body.method,
      body.reason,
      body.idempotencyKey ?? null,
    )
    return ok(result, result.replayed ? 200 : 201)
  },
)
