import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { ConflictError } from '@/lib/errors'
import { checkout } from '@/lib/checkout'
import { PaymentMethodSchema, ServiceKindSchema } from '@/lib/enums'
import { IdempotencyKeySchema } from '@/lib/idempotency'
import { findOpenShift } from '@/lib/shift/service'

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

/**
 * Jasa pembayaran.
 *
 * Perhatikan yang TIDAK ada di sini juga: `direction` dan `label`. Keduanya
 * datang dari katalog di server (`src/lib/service/catalog.ts`). Kalau arah uang
 * boleh ditentukan client, siapa pun di WiFi toko bisa mengirim tarik tunai
 * bertanda terbalik dan menguras laci lewat satu request.
 */
const ServiceLineSchema = z.object({
  kind: ServiceKindSchema,
  providerId: z.string().uuid(),
  /** Titipan yang diteruskan ke provider. Selalu positif. */
  passthroughAmount: z.number().int().min(1).max(2_147_483_647),
  /** Biaya admin — pendapatan toko. Boleh nol, toko memang boleh tidak memungut. */
  serviceFeeAmount: z.number().int().min(0).max(2_147_483_647),
  /** Potongan provider ke toko, kalau ada. Masuk HPP. */
  providerCostAmount: z.number().int().min(0).max(2_147_483_647).optional(),
  customerRef: z.string().trim().max(60).optional(),
  note: z.string().trim().max(200).optional(),
})

const CheckoutSchema = z
  .object({
    // Tidak lagi `.min(1)`: keranjang boleh berisi jasa saja. Yang dijaga adalah
    // "tidak kosong sama sekali", lewat refine di bawah.
    lines: z.array(LineSchema).max(200).default([]),
    services: z.array(ServiceLineSchema).max(20).default([]),
    transactionDiscount: z.number().int().min(0).default(0),
    method: PaymentMethodSchema,
    amountTendered: z.number().int().min(0).optional(),
    note: z.string().trim().max(500).optional(),
    // WAJIB. Response yang hilang di WiFi toko membuat kasir menekan Bayar dua
    // kali; tanpa kunci itu tercatat sebagai dua penjualan. Perlindungannya tidak
    // boleh bergantung pada kedisiplinan client (src/lib/idempotency.ts).
    idempotencyKey: IdempotencyKeySchema,
  })
  .refine((v) => v.lines.length > 0 || v.services.length > 0, {
    message: 'Keranjang kosong',
    path: ['lines'],
  })
  .refine((v) => v.method !== 'CASH' || v.amountTendered !== undefined, {
    message: 'Nominal uang yang diterima wajib diisi untuk pembayaran tunai',
    path: ['amountTendered'],
  })

export const POST = route('transactions.create', async (req) => {
  const session = await requireSession()

  // Body di-parse LEBIH DULU, sebelum pemeriksaan bisnis apa pun.
  //
  // Urutan ini bagian dari kontrak: request tanpa idempotencyKey harus ditolak
  // 400 tanpa sistem menyentuh apa pun — bukan ditolak 409 karena kebetulan
  // shiftnya juga belum dibuka. Alasan penolakan yang salah menuntun kasir ke
  // tindakan yang salah.
  const body = await parseBody(req, CheckoutSchema)

  // Tidak ada penjualan di luar shift. Sebelum Fase 3, shift dibuka otomatis
  // dengan kas awal nol supaya Fase 2 bisa diuji — itu membuat rekonsiliasi kas
  // tidak berarti apa-apa, jadi scaffolding-nya dihapus di sini.
  const shift = await findOpenShift(session.id)
  if (!shift) {
    throw new ConflictError('Belum ada shift terbuka. Buka shift dulu sebelum bertransaksi.')
  }

  const result = await checkout(body, {
    userId: session.id,
    shiftId: shift.id,
    role: session.role,
    ip: clientIp(req),
    deviceLabel: deviceLabel(req),
  })

  // 200, bukan 201: request ini tidak membuat apa pun. Bedanya bukan kosmetik —
  // ia yang memberi tahu layar kasir bahwa penjualannya sudah tersimpan sejak
  // tadi, sehingga kasir tidak menyangka baru saja terjadi penjualan kedua.
  return ok(result, result.replayed ? 200 : 201)
})
