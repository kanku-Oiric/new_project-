import { ok, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { enqueue } from '@/lib/notify/queue'
import { retryDelivery } from '@/lib/report/service'

export const dynamic = 'force-dynamic'

/**
 * Coba kirim ulang satu baris yang gagal.
 *
 * Baris yang gagal permanen (webhook dihapus, token dicabut) tidak pernah
 * dicoba lagi otomatis — inilah jalannya setelah pengaturannya dibetulkan.
 * Yang sudah SENT tidak dikirim ulang diam-diam: jawabannya SKIPPED, dengan
 * alasannya.
 */
export const POST = route(
  'reports.retry',
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole('OWNER')
    const { id } = await ctx.params
    return ok(await enqueue(() => retryDelivery(id)))
  },
)
