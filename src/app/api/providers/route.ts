import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, parseQuery, route } from '@/lib/api'
import { requireRole, requireSession } from '@/lib/auth/session'
import { ProviderKindSchema } from '@/lib/enums'
import { createServiceProvider, listServiceProviders } from '@/lib/provider/service'

export const dynamic = 'force-dynamic'

const ListSchema = z.object({
  /** Pemilik butuh yang nonaktif juga di halaman saldo; layar kasir tidak. */
  includeInactive: z.enum(['0', '1']).optional(),
})

const CreateSchema = z.object({
  nama: z.string().trim().min(1).max(40),
  jenis: ProviderKindSchema,
  saldoAwal: z.number().int().min(0).max(2_147_483_647).default(0),
  urutan: z.number().int().min(0).max(999).optional(),
})

/**
 * Daftar provider beserta saldonya.
 *
 * Kasir ikut boleh membacanya: layar kasir menampilkan saldo di tombol pilihan
 * provider, supaya kasir tahu sebelum menjual — bukan setelah saldonya minus.
 * Saldo bukan angka rahasia seperti harga beli; ia justru harus terlihat saat
 * transaksi dibuat.
 */
export const GET = route('providers.list', async (req) => {
  await requireSession()
  const { includeInactive } = parseQuery(req, ListSchema)

  return ok({ providers: await listServiceProviders(includeInactive === '1') })
})

export const POST = route('providers.create', async (req) => {
  // Menambah provider berarti menambah akun uang. Pemilik saja.
  const session = await requireRole('OWNER')
  const body = await parseBody(req, CreateSchema)

  const provider = await createServiceProvider(
    { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
    body,
  )
  return ok({ provider }, 201)
})
