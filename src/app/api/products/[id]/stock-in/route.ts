import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { stockIn } from '@/lib/product/service'

export const dynamic = 'force-dynamic'

const StockInSchema = z.object({
  qty: z.number().int().min(1).max(1_000_000),
  hargaBeli: z.number().int().min(0).max(2_147_483_647).optional(),
  note: z.string().trim().max(300).optional(),
})

export const POST = route(
  'products.stockIn',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    // Barang masuk mengubah harga beli, yang menentukan laba kotor. Pemilik saja.
    const session = await requireRole('OWNER')
    const { id } = await ctx.params
    const body = await parseBody(req, StockInSchema)

    const result = await stockIn(
      { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
      id,
      body.qty,
      body.hargaBeli,
      body.note,
    )
    return ok(result, 201)
  },
)
