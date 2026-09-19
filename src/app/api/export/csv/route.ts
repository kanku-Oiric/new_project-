import { NextResponse } from 'next/server'
import { route } from '@/lib/api'
import { recordAuditSafe } from '@/lib/audit'
import { requireRole } from '@/lib/auth/session'
import { buildExport } from '@/lib/backup/export'

export const dynamic = 'force-dynamic'

/**
 * Export semua data ke satu ZIP berisi CSV. Hanya pemilik.
 *
 * Mengembalikan berkas, bukan JSON, jadi ia tidak memakai helper `ok()`.
 * `Content-Disposition: attachment` yang membuat browser mengunduhnya alih-alih
 * menampilkan isi ZIP sebagai teks kacau.
 *
 * Pengambilan data yang berhasil TETAP dicatat di audit log. Seluruh riwayat
 * penjualan toko keluar lewat satu klik di sini; siapa dan kapan adalah hal yang
 * harus bisa dijawab belakangan.
 */
export const GET = route('export.csv', async () => {
  const session = await requireRole('OWNER')

  const result = await buildExport()

  await recordAuditSafe(
    { userId: session.id, role: session.role },
    {
      action: 'BACKUP_RUN',
      summary: `Export CSV oleh ${session.name}: ${result.fileName}`,
      after: { fileName: result.fileName, rowCounts: result.rowCounts },
    },
  )

  return new NextResponse(new Uint8Array(result.zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
      'Content-Length': String(result.zip.length),
      // Jangan pernah di-cache: isinya berubah setiap kali ada penjualan, dan
      // salinan basi di sini berarti akuntan menerima data yang salah.
      'Cache-Control': 'no-store',
    },
  })
})
