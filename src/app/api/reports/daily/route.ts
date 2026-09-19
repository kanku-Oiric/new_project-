import { z } from 'zod'
import { ok, parseQuery, route } from '@/lib/api'
import { requireRole } from '@/lib/auth/session'
import { config } from '@/lib/config'
import { buildReport } from '@/lib/report/service'
import { toBusinessDate } from '@/lib/time'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD')
    .optional(),
})

/**
 * Laporan harian.
 *
 * Owner saja: isinya memuat HPP dan laba kotor, dan margin toko bukan konsumsi
 * karyawan yang berdiri di depan pelanggan.
 *
 * Angkanya dihitung ulang setiap kali diminta, bukan dibaca dari tabel ringkasan
 * — jadi memperbaiki bug perhitungan langsung memperbaiki laporan lama juga
 * (docs/reporting.md §7.1).
 */
export const GET = route('reports.daily', async (req) => {
  await requireRole('OWNER')
  const { date } = parseQuery(req, QuerySchema)
  const periodKey = date ?? toBusinessDate(new Date(), config.timezone)
  return ok(await buildReport('DAILY', periodKey))
})
