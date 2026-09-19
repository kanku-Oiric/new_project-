import { clientIp, deviceLabel, ok, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { confirmPayment } from '@/lib/payment/service'

export const dynamic = 'force-dynamic'

/**
 * Satu-satunya jalan sebuah pembayaran QRIS statis menjadi PAID.
 *
 * Yang membuatnya sah bukan providernya, melainkan tiga hal di baris-baris di
 * bawah: ada session terautentikasi, ada request yang dipicu manusia menekan
 * tombol, dan id orang itu tercatat sebagai `confirmedByUserId` (docs/qris.md §3.2).
 *
 * Tidak ada body: konfirmasi bukan tempat menegosiasikan nominal. Nominalnya
 * sudah ditetapkan server saat transaksi dibuat.
 */
export const POST = route(
  'payments.confirm',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession()
    const { id } = await ctx.params

    const result = await confirmPayment(id, {
      userId: session.id,
      role: session.role,
      ip: clientIp(req),
      deviceLabel: deviceLabel(req),
    })

    return ok(result)
  },
)
