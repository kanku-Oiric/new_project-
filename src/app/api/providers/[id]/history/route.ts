import { ok, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { providerHistory } from '@/lib/provider/service'

export const dynamic = 'force-dynamic'

/**
 * Riwayat pergerakan saldo satu provider.
 *
 * Pemilik saja: ini jejak uang, sejajar dengan audit log. Kasir cukup melihat
 * saldo sekarang di layar kasir untuk tahu apakah transaksinya bisa dilayani.
 */
export const GET = route(
  'providers.history',
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole('OWNER')
    const { id } = await ctx.params

    return ok({ movements: await providerHistory(id) })
  },
)
