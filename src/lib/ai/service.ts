import 'server-only'
import type { Db } from '../audit'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { createLogger } from '../logger'
import type { AggregateComparison, SalesAggregate } from '../report'
import { toBusinessDate } from '../time'
import { readCachedInsight, type CachedInsight } from './cache'
import { AiError, callGemini } from './client'
import { buildAiPayload, type AiReportKind } from './payload'
import { formatInsight, parseInsight } from './schema'

const log = createLogger('ai')

/**
 * Analisis AI — penegakan seluruh aturannya ada di berkas ini.
 *
 * Empat gerbang, berurutan, dan semuanya DI DEPAN panggilan HTTP:
 *
 *   1. `AI_ENABLED` — default mati. Mati berarti tidak ada request, bukan request
 *      yang hasilnya diabaikan.
 *   2. Kunci API ada. Tidak ada kunci berarti "belum dikonfigurasi", dikatakan
 *      apa adanya, bukan dicoba lalu gagal.
 *   3. Hanya WEEKLY dan MONTHLY. Tidak pernah harian, dan tidak pernah
 *      per transaksi — tidak ada satu pun pemanggil di jalur checkout.
 *   4. Maksimal SATU panggilan per hari usaha, dihitung dari `ai_call_logs`.
 *
 * Gerbang 4 menghitung SEMUA baris hari itu, termasuk yang gagal. Konsekuensinya
 * jujur dan disengaja: satu jawaban ngawur menghabiskan kuota hari itu. Yang
 * dicegah adalah kunci rusak atau model yang terus menjawab salah ditembak
 * berulang kali sepanjang hari — biayanya nyata dan tagihannya ke pemilik toko.
 */

export type InsightStatus =
  /** `AI_ENABLED=false`. Tidak ada request yang dibuat. */
  | 'DISABLED'
  /** AI aktif tapi `GEMINI_API_KEY` kosong. */
  | 'NOT_CONFIGURED'
  /** Laporan harian tidak pernah dianalisis. */
  | 'UNSUPPORTED_KIND'
  /** Sudah ada hasil tersimpan; tidak ada panggilan API. */
  | 'CACHED'
  /** Baru dipanggil, lolos validasi, tersimpan. */
  | 'FRESH'
  /** Kuota hari ini sudah terpakai. */
  | 'LIMIT_REACHED'
  /** API menjawab, tapi keluarannya tidak lolos validasi Zod. */
  | 'INVALID'
  /** API tidak bisa dihubungi atau menjawab error. */
  | 'FAILED'

export interface InsightResult {
  status: InsightStatus
  /** Teks siap tampil. null untuk semua status selain CACHED dan FRESH. */
  text: string | null
  /** Penjelasan untuk pemilik. Selalu terisi, selalu apa adanya. */
  message: string
  model: string | null
  createdAt: Date | null
}

export interface InsightInput {
  kind: AiReportKind
  periodKey: string
  aggregate: SalesAggregate
  comparison?: AggregateComparison | null
}

export interface InsightOptions {
  db?: Db
  now?: Date
  /** Minta panggilan baru walau sudah ada hasil tersimpan. Tetap tunduk batas harian. */
  refresh?: boolean
  requestedByUserId?: string | null
  /** Disuntik test. Tanpa ini tidak ada satu pun test yang menyentuh internet. */
  fetchImpl?: typeof fetch
}

/** Batas panggilan per hari usaha. Satu. */
export const DAILY_CALL_LIMIT = 1

function hasil(
  status: InsightStatus,
  message: string,
  extra: Partial<Pick<InsightResult, 'text' | 'model' | 'createdAt'>> = {},
): InsightResult {
  return {
    status,
    message,
    text: extra.text ?? null,
    model: extra.model ?? null,
    createdAt: extra.createdAt ?? null,
  }
}

function dariCache(cached: CachedInsight): InsightResult {
  return hasil('CACHED', 'Menampilkan analisis yang sudah tersimpan. Tidak ada panggilan API.', {
    text: cached.text,
    model: cached.model,
    createdAt: cached.createdAt,
  })
}

/** Jumlah panggilan pada satu hari usaha, sukses maupun gagal. */
export async function countCallsOnDate(businessDate: string, db: Db = prisma): Promise<number> {
  return db.aiCallLog.count({ where: { businessDate } })
}

/**
 * Minta analisis.
 *
 * Tidak pernah melempar karena kegagalan AI: seluruh kegagalan kembali sebagai
 * `status` yang bisa ditampilkan. Fitur ini berada di pinggir sistem, dan
 * kegagalan di pinggir tidak boleh menjatuhkan apa pun di tengah.
 */
export async function requestInsight(
  input: InsightInput,
  options: InsightOptions = {},
): Promise<InsightResult> {
  const db = options.db ?? prisma
  const now = options.now ?? new Date()

  // ── Gerbang 1 & 2: konfigurasi ──
  if (!config.ai.enabled) {
    return hasil(
      'DISABLED',
      'Analisis AI dimatikan (AI_ENABLED=false). Semua laporan tetap dihitung dan dikirim seperti biasa.',
    )
  }
  if (!config.ai.apiKey) {
    return hasil(
      'NOT_CONFIGURED',
      'AI_ENABLED=true tapi GEMINI_API_KEY masih kosong. Isi di berkas .env, lalu nyalakan ulang sistem.',
    )
  }

  // ── Gerbang 3: jenis laporan ──
  if (input.kind !== 'WEEKLY' && input.kind !== 'MONTHLY') {
    return hasil('UNSUPPORTED_KIND', 'Analisis hanya untuk laporan mingguan dan bulanan.')
  }

  // Cache dibaca SEBELUM gerbang kuota: membaca hasil yang sudah ada tidak
  // menghabiskan apa pun, dan menolaknya karena kuota akan menyembunyikan
  // analisis yang sudah dibayar kemarin.
  const cached = await readCachedInsight(input.kind, input.periodKey, db)
  if (cached && !options.refresh) return dariCache(cached)

  // ── Gerbang 4: batas harian, sebelum HTTP call apa pun ──
  const businessDate = toBusinessDate(now, config.timezone)
  const dipakai = await countCallsOnDate(businessDate, db)
  if (dipakai >= DAILY_CALL_LIMIT) {
    const catatan = `Kuota analisis hari ini sudah terpakai (${dipakai} dari ${DAILY_CALL_LIMIT}). Coba lagi besok.`
    // Kalau ada hasil lama, tetap ditampilkan — lebih berguna daripada layar
    // kosong, selama yang ditampilkan jujur soal kapan ia dibuat.
    if (cached) {
      return hasil('CACHED', `${catatan} Yang ditampilkan adalah analisis tersimpan.`, {
        text: cached.text,
        model: cached.model,
        createdAt: cached.createdAt,
      })
    }
    return hasil('LIMIT_REACHED', catatan)
  }

  const payload = buildAiPayload(input.aggregate, input, input.comparison ?? null)
  const model = config.ai.model

  let raw: string
  try {
    raw = await callGemini(payload, {
      apiKey: config.ai.apiKey,
      model,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
  } catch (e) {
    const error = e instanceof AiError ? e.message : e instanceof Error ? e.message : String(e)
    await catatPanggilan(db, { businessDate, input, ok: false, model, errorMessage: error })
    log.warn('panggilan Gemini gagal', { kind: input.kind, periodKey: input.periodKey, error })
    return hasil('FAILED', `Analisis gagal: ${error}`)
  }

  const parsed = parseInsight(raw)
  if (!parsed.ok) {
    // Keluaran yang tidak lolos validasi TIDAK ditulis ke ai_insights. Hanya
    // hasil yang sah boleh tersimpan (docs/architecture.md §12).
    await catatPanggilan(db, { businessDate, input, ok: false, model, errorMessage: parsed.error })
    log.warn('keluaran Gemini tidak lolos validasi', {
      kind: input.kind,
      periodKey: input.periodKey,
      error: parsed.error,
    })
    return hasil(
      'INVALID',
      `Jawaban AI tidak sesuai bentuk yang diminta, jadi dilewati. Laporan tetap lengkap tanpa bagian analisis. (${parsed.error})`,
    )
  }

  const text = formatInsight(parsed.insight)

  const row = await db.aiInsight.create({
    data: {
      kind: input.kind,
      periodKey: input.periodKey,
      model,
      insightJson: JSON.stringify(parsed.insight),
      requestedByUserId: options.requestedByUserId ?? null,
    },
  })
  await catatPanggilan(db, { businessDate, input, ok: true, model, errorMessage: null })

  return hasil('FRESH', 'Analisis baru selesai dibuat.', {
    text,
    model,
    createdAt: row.createdAt,
  })
}

async function catatPanggilan(
  db: Db,
  args: {
    businessDate: string
    input: InsightInput
    ok: boolean
    model: string
    errorMessage: string | null
  },
): Promise<void> {
  try {
    await db.aiCallLog.create({
      data: {
        businessDate: args.businessDate,
        kind: args.input.kind,
        periodKey: args.input.periodKey,
        ok: args.ok,
        model: args.model,
        errorMessage: args.errorMessage,
      },
    })
  } catch (e) {
    // Gagal mencatat tidak boleh menjatuhkan apa pun. Tapi harus terlihat: baris
    // inilah yang menegakkan batas harian, dan tanpa ia kuota jadi tak terbatas.
    log.error('gagal menulis ai_call_logs', e)
  }
}

/**
 * Untuk jalur pengiriman laporan otomatis: kembalikan teks analisis kalau bisa,
 * `null` kalau tidak — apa pun alasannya.
 *
 * TIDAK PERNAH melempar dan tidak pernah menunda pengiriman lebih dari satu
 * panggilan API. Laporan yang benar terkirim tanpa analisis jauh lebih berguna
 * daripada laporan yang tidak terkirim karena analisisnya gagal.
 */
export async function insightTextForDelivery(
  input: InsightInput,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const result = await requestInsight(input, { db, now })
    return result.text
  } catch (e) {
    log.error('insightTextForDelivery gagal tak terduga', e)
    return null
  }
}
