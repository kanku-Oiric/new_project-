import { ok, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { readPaymentStatus } from '@/lib/payment/service'

export const dynamic = 'force-dynamic'

/**
 * Baca status pembayaran. HANYA membaca.
 *
 * Endpoint ini tidak pernah melunaskan, membatalkan, atau mengubah apa pun,
 * bahkan kalau provider melaporkan PAID. Untuk QRIS statis, providernya
 * mengembalikan status yang tersimpan — jadi memanggil endpoint ini seribu kali
 * tidak akan pernah menghasilkan transaksi lunas.
 *
 * Gunanya nyata: dua device melihat transaksi yang sama, dan device kedua perlu
 * tahu bahwa yang pertama sudah mengonfirmasi.
 */
export const GET = route(
  'payments.status',
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireSession()
    const { id } = await ctx.params
    return ok(await readPaymentStatus(id))
  },
)
