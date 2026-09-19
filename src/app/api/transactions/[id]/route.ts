import { ok, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { NotFoundError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export const GET = route(
  'transactions.detail',
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireSession()
    const { id } = await ctx.params

    const transaction = await prisma.transaction.findUnique({
      where: { id },
      include: {
        items: { orderBy: { productName: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
        cashier: { select: { name: true } },
      },
    })

    if (!transaction) throw new NotFoundError('Transaksi tidak ditemukan')

    return ok({ transaction })
  },
)
