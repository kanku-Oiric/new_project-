import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { ExpenseSourceSchema } from '@/lib/enums'
import { ConflictError } from '@/lib/errors'
import { IdempotencyKeySchema } from '@/lib/idempotency'
import { topupProvider } from '@/lib/provider/service'
import { findOpenShift } from '@/lib/shift/service'

export const dynamic = 'force-dynamic'

const TopupSchema = z.object({
  amount: z.number().int().min(1).max(2_147_483_647),
  /** CASH_DRAWER = uangnya diambil dari laci, jadi expected cash ikut berkurang. */
  paidFrom: ExpenseSourceSchema.default('CASH_DRAWER'),
  note: z.string().trim().max(300).optional(),
  // WAJIB. Top-up yang tercatat dua kali berarti laci dianggap berkurang dua
  // kali, dan kasirnya yang tampak kehilangan uang (src/lib/idempotency.ts).
  idempotencyKey: IdempotencyKeySchema,
})

/**
 * Isi saldo provider.
 *
 * Kasir ikut boleh: uang yang dipakai mengisi saldo diambil dari LACINYA, dan
 * kalau ia tidak bisa mencatatnya sendiri maka shiftnya akan ditutup dengan
 * selisih sebesar nominal top-up — dan yang dicurigai adalah dia.
 */
export const POST = route(
  'providers.topup',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession()
    const { id } = await ctx.params

    // Body lebih dulu, sebelum pemeriksaan bisnis apa pun — request tanpa kunci
    // harus dijawab 400 "kunci wajib", bukan 409 "belum ada shift".
    const body = await parseBody(req, TopupSchema)

    // Top-up dari laci HARUS menempel ke sebuah shift, kalau tidak ia tidak akan
    // pernah muncul di rekonsiliasi kas mana pun dan uangnya hilang dari catatan.
    // Top-up dari luar laci tidak menyentuh laci, jadi tidak butuh shift.
    let shiftId: string | undefined
    if (body.paidFrom === 'CASH_DRAWER') {
      const shift = await findOpenShift(session.id)
      if (!shift) {
        throw new ConflictError(
          'Belum ada shift terbuka. Top-up dari laci harus tercatat pada shift supaya ikut dalam rekonsiliasi kas.',
        )
      }
      shiftId = shift.id
    }

    const result = await topupProvider(
      { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
      id,
      { ...body, shiftId },
    )

    return ok(result, result.replayed ? 200 : 201)
  },
)
