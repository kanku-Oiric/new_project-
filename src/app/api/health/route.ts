import { ok, route } from '@/lib/api'
import { listBackups } from '@/lib/backup'
import { config } from '@/lib/config'
// Dari db/maintenance, bukan dari startup: /api/health tidak perlu menarik
// modul backup dan logger hanya untuk menjalankan satu SELECT 1.
import { checkDatabase } from '@/lib/db/maintenance'
import { toBusinessDate } from '@/lib/time'

export const dynamic = 'force-dynamic'

/**
 * Cek kesehatan. Sengaja terbuka tanpa login supaya pemilik bisa memastikan
 * server hidup dari HP-nya tanpa harus masuk dulu. Tidak membocorkan data
 * penjualan — hanya status teknis.
 */
export const GET = route('health', async () => {
  const db = await checkDatabase()
  const backups = listBackups()
  const latest = backups[0] ?? null
  const now = new Date()

  return ok({
    ok: db.ok,
    database: db,
    timezone: config.timezone,
    businessDate: toBusinessDate(now, config.timezone),
    serverTime: now.toISOString(),
    backup: {
      count: backups.length,
      latestFile: latest?.file ?? null,
      latestAt: latest?.modifiedAt.toISOString() ?? null,
    },
  })
})
