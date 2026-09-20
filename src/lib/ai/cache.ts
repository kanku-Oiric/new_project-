import 'server-only'
import type { Db } from '../audit'
import { prisma } from '../db/prisma'
import { formatInsight, InsightSchema } from './schema'
import type { AiReportKind } from './payload'

/**
 * Pembacaan `ai_insights` — tanpa satu pun panggilan API.
 *
 * Dipisahkan dari `service.ts` supaya `report/service.ts` bisa membaca cache
 * tanpa menarik klien Gemini ke dalam module graph-nya. Laporan yang ditampilkan
 * di layar tidak boleh punya jalur apa pun menuju request ke internet: satu
 * pemilik yang membuka /laporan tiga kali tidak boleh menghabiskan kuota harian.
 *
 * Tabel ini APPEND-ONLY. Analisis ulang membuat baris baru; pembaca mengambil
 * `createdAt` terbaru. Tidak ada `update` maupun `delete` di berkas ini, dan
 * tidak ada endpoint untuk keduanya.
 */

export interface CachedInsight {
  text: string
  model: string
  createdAt: Date
  requestedByUserId: string | null
}

export async function readCachedInsight(
  kind: AiReportKind,
  periodKey: string,
  db: Db = prisma,
): Promise<CachedInsight | null> {
  const row = await db.aiInsight.findFirst({
    where: { kind, periodKey },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return null

  // Yang tersimpan sudah pernah lolos validasi saat ditulis. Divalidasi lagi di
  // sini karena baris yang rusak (hasil edit manual di DB, misalnya) tidak boleh
  // menjatuhkan halaman laporan — ia cukup dianggap tidak ada.
  let parsed: unknown
  try {
    parsed = JSON.parse(row.insightJson)
  } catch {
    return null
  }

  const hasil = InsightSchema.safeParse(parsed)
  if (!hasil.success) return null

  return {
    text: formatInsight(hasil.data),
    model: row.model,
    createdAt: row.createdAt,
    requestedByUserId: row.requestedByUserId,
  }
}

/** Teks siap tempel ke `ReportMessage`, atau null kalau belum ada. */
export async function readCachedInsightText(
  kind: AiReportKind,
  periodKey: string,
  db: Db = prisma,
): Promise<string | null> {
  const cached = await readCachedInsight(kind, periodKey, db)
  return cached?.text ?? null
}
