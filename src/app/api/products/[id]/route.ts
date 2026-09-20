import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { verifyOwnerPin } from '@/lib/auth/login'
import { PinSchema } from '@/lib/auth/pin'
import { requireRole } from '@/lib/auth/session'
import { deleteProduct, updateProduct } from '@/lib/product/service'

export const dynamic = 'force-dynamic'

const UpdateSchema = z.object({
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: z.string().trim().max(40).nullable().optional(),
  nama: z.string().trim().min(1).max(120).optional(),
  kategori: z.string().trim().min(1).max(60).optional(),
  hargaBeli: z.number().int().min(0).max(2_147_483_647).optional(),
  hargaJual: z.number().int().min(0).max(2_147_483_647).optional(),
  stokMinimum: z.number().int().min(0).max(1_000_000).optional(),
  satuan: z.string().trim().min(1).max(20).optional(),
  aktif: z.boolean().optional(),
})

const DeleteSchema = z.object({
  ownerPin: PinSchema,
})

/**
 * Ubah produk.
 *
 * `requireRole('OWNER')` di SERVER, bukan sekadar menyembunyikan tombol di
 * layar. Menyembunyikan tombol bukan otorisasi: siapa pun di WiFi toko bisa
 * memanggil endpoint ini langsung dengan `curl`, dan harga jual adalah angka
 * yang menentukan uang masuk.
 */
export const PATCH = route(
  'products.update',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireRole('OWNER')
    const { id } = await ctx.params
    const body = await parseBody(req, UpdateSchema)

    const product = await updateProduct(
      { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
      id,
      body,
    )
    return ok({ product })
  },
)

/**
 * Hapus produk — PIN pemilik, diverifikasi server.
 *
 * PIN diminta ULANG walaupun sessionnya sudah pemilik, sejalan dengan void dan
 * refund: layar yang ditinggalkan terbuka di meja kasir adalah session pemilik
 * yang sedang berjalan, dan menghapus produk menghilangkannya dari layar kasir
 * seluruh toko.
 *
 * Yang terjadi setelahnya bergantung pada riwayat produknya, dan jawabannya
 * disebut apa adanya lewat `hardDeleted` — lihat `deleteProduct`.
 */
export const DELETE = route(
  'products.delete',
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireRole('OWNER')
    const { id } = await ctx.params
    const body = await parseBody(req, DeleteSchema)

    const authorizedByUserId = await verifyOwnerPin(body.ownerPin)

    const result = await deleteProduct(
      {
        userId: session.id,
        role: session.role,
        authorizedByUserId,
        ip: clientIp(req),
        deviceLabel: deviceLabel(req),
      },
      id,
    )
    return ok(result)
  },
)
