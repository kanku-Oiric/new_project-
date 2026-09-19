import { clientIp, deviceLabel, ok, route } from '@/lib/api'
import { recordAuditSafe } from '@/lib/audit'
import { requireRole } from '@/lib/auth/session'
import { runBackup } from '@/lib/backup'

export const dynamic = 'force-dynamic'

/**
 * "Backup sekarang" — dijalankan pemilik dari halaman Pengaturan.
 *
 * Backup sudah otomatis berjalan saat server menyala dan saat tutup shift, jadi
 * tombol ini bukan pengganti keduanya. Gunanya adalah saat pemilik tahu sesuatu
 * yang sistem tidak tahu: sebelum mencabut laptop untuk dibawa pulang, sebelum
 * mengubah harga puluhan produk, atau setelah hari yang sangat ramai.
 *
 * Hasilnya dikembalikan APA ADANYA, termasuk kalau verifikasinya gagal. Pemilik
 * harus bisa membedakan "backup dibuat" dari "backup dibuat dan terbukti bisa
 * dibuka" — dua kalimat yang mudah dicampur, padahal hanya yang kedua berguna
 * saat laptopnya mati.
 */
export const POST = route('backup.run', async (req) => {
  const session = await requireRole('OWNER')

  const result = await runBackup()

  // runBackup sudah menulis satu baris BACKUP_RUN tanpa pelaku (ia juga dipakai
  // startup). Baris ini menambahkan siapa yang menekan tombolnya — pertanyaan
  // "siapa yang membuat backup ini" harus bisa dijawab audit log.
  await recordAuditSafe(
    {
      userId: session.id,
      role: session.role,
      ip: clientIp(req),
      deviceLabel: deviceLabel(req),
    },
    {
      action: 'BACKUP_RUN',
      summary: `Backup manual oleh ${session.name}: ${result.file ?? 'GAGAL'}`,
      after: {
        file: result.file,
        verified: result.verification.ok,
        transactionCount: result.verification.transactionCount,
        mirroredTo: result.mirroredTo,
      },
    },
  )

  return ok({
    ok: result.ok,
    file: result.file,
    sizeBytes: result.sizeBytes,
    prunedCount: result.prunedCount,
    mirroredTo: result.mirroredTo,
    error: result.error,
    verification: result.verification,
  })
})
