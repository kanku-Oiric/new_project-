import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { ManualStockReasonSchema } from '@/lib/enums'
import { adjustStock } from '@/lib/product/service'

export const dynamic = 'force-dynamic'

const AdjustSchema = z
  .object({
    newQty: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    qtyChange: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    reason: ManualStockReasonSchema,
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.newQty !== undefined || v.qtyChange !== undefined, {
    message: 'Isi jumlah baru atau selisihnya',
    path: ['newQty'],
  })

export const POST = route(
  'products.stockAdjustment',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireRole('OWNER')
    const { id } = await ctx.params
    const body = await parseBody(req, AdjustSchema)

    const result = await adjustStock(
      { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
      id,
      body,
    )
    return ok(result, 201)
  },
)
