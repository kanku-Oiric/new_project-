import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { checkout } from '@/lib/checkout'
import { PaymentMethodSchema } from '@/lib/enums'
import { ensureOpenShift } from '@/lib/shift/current'

export const dynamic = 'force-dynamic'

/**
 * Perhatikan yang TIDAK ada di skema ini: harga.
 *
 * Client hanya menentukan produk mana, berapa banyak, dan berapa diskonnya.
 * Harga jual dan harga beli dimuat server dari database saat checkout. Kalau
 * harga ikut dikirim client, siapa pun di WiFi toko bisa membeli barang
 * seharga satu rupiah.
 */
const LineSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().min(1).max(10_000),
  itemDiscount: z.number().int().min(0).default(0),
})

const CheckoutSchema = z
  .object({
    lines: z.array(LineSchema).min(1, 'Keranjang kosong').max(200),
    transactionDiscount: z.number().int().min(0).default(0),
    method: PaymentMethodSchema,
    amountTendered: z.number().int().min(0).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.method !== 'CASH' || v.amountTendered !== undefined, {
    message: 'Nominal uang yang diterima wajib diisi untuk pembayaran tunai',
    path: ['amountTendered'],
  })

export const POST = route('transactions.create', async (req) => {
  const session = await requireSession()

  // Scaffolding Fase 2: shift dibuka otomatis kalau belum ada. Fase 3 menggantinya
  // dengan layar buka/tutup shift dan menolak checkout tanpa shift OPEN.
  const shiftId = await ensureOpenShift(session.id)

  const body = await parseBody(req, CheckoutSchema)

  const result = await checkout(body, {
    userId: session.id,
    shiftId,
    role: session.role,
    ip: clientIp(req),
    deviceLabel: deviceLabel(req),
  })

  return ok(result, 201)
})
