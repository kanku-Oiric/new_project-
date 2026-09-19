import fs from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { NotFoundError } from '@/lib/errors'
import { contentTypeForUpload, isSafeUploadName, uploadPathFor } from '@/lib/uploads'

export const dynamic = 'force-dynamic'

/**
 * Layani gambar unggahan dari `data/uploads/`.
 *
 * Berkasnya TIDAK ditaruh di `public/` dengan sengaja: `public/` terbuka tanpa
 * login. Gambar QR toko bukan rahasia besar, tapi tidak ada alasan menyiarkannya
 * ke siapa pun yang bisa menjangkau alamat server.
 *
 * Hanya satu segmen nama berkas yang dilayani, dan hanya tipe gambar yang
 * dikenal. Segala bentuk `../` ditolak sebelum menyentuh filesystem.
 */
export const GET = route(
  'uploads.read',
  async (_req: Request, ctx: { params: Promise<{ path: string[] }> }) => {
    await requireSession()

    const { path: segments } = await ctx.params
    const name = segments.length === 1 ? segments[0] : undefined
    if (!name || !isSafeUploadName(name)) {
      throw new NotFoundError('Berkas tidak ditemukan')
    }

    const contentType = contentTypeForUpload(name)
    if (!contentType) throw new NotFoundError('Berkas tidak ditemukan')

    let bytes: Buffer
    try {
      bytes = await fs.readFile(uploadPathFor(name))
    } catch {
      // Setting bisa menunjuk berkas yang sudah hilang dari disk (mis. setelah
      // restore database tanpa folder uploads). Itu 404, bukan kerusakan server.
      throw new NotFoundError('Berkas tidak ditemukan')
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=60',
      },
    })
  },
)
