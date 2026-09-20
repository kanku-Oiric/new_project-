import { z } from 'zod'

/**
 * Bentuk keluaran AI yang diterima — dan satu-satunya yang boleh tersimpan.
 *
 * Divalidasi Zod sebelum apa pun dilakukan terhadapnya. Keluaran yang tidak
 * lolos TIDAK ditulis ke `ai_insights`, tidak masuk laporan, dan tidak
 * menggagalkan apa pun: bagian AI-nya hilang, sisanya jalan seperti biasa
 * (docs/architecture.md §12).
 *
 * Batas panjang bukan hiasan. Tanpa `max`, satu jawaban yang mengamuk bisa
 * menghasilkan ribuan karakter yang masuk ke pesan Discord, ditolak API-nya
 * karena melewati batas field, dan membuat laporan yang seharusnya terkirim
 * gagal — kegagalan di bagian yang paling tidak penting menjatuhkan bagian yang
 * penting.
 */
export const InsightSchema = z.object({
  ringkasan: z.string().trim().min(10).max(600),
  temuan: z.array(z.string().trim().min(3).max(300)).min(1).max(5),
  saran: z.array(z.string().trim().min(3).max(300)).min(1).max(5),
})

export type Insight = z.infer<typeof InsightSchema>

/**
 * Susun teks yang dibaca manusia.
 *
 * Keluaran AI diperlakukan sebagai DATA, bukan instruksi: ia hanya dirangkai
 * menjadi teks biasa. Tidak pernah dievaluasi, tidak pernah menjadi bagian
 * query, dan tidak pernah memicu aksi apa pun di sistem ini.
 */
export function formatInsight(insight: Insight): string {
  const baris = [insight.ringkasan, '', 'Temuan:']
  for (const t of insight.temuan) baris.push(`• ${t}`)
  baris.push('', 'Saran:')
  for (const s of insight.saran) baris.push(`• ${s}`)
  return baris.join('\n')
}

/**
 * Parse keluaran mentah model.
 *
 * Model kadang membungkus JSON dalam blok kode markdown walau sudah diminta
 * JSON murni. Pembungkus itu dilepas di sini — bukan karena kita memaafkan
 * keluaran yang tidak sesuai permintaan, tapi karena membuang jawaban yang
 * isinya benar hanya gara-gara tiga petik akan membakar kuota satu hari.
 */
export function parseInsight(raw: string): { ok: true; insight: Insight } | { ok: false; error: string } {
  const bersih = stripCodeFence(raw.trim())

  let json: unknown
  try {
    json = JSON.parse(bersih)
  } catch {
    return { ok: false, error: 'keluaran bukan JSON yang bisa di-parse' }
  }

  const parsed = InsightSchema.safeParse(json)
  if (!parsed.success) {
    const pesan = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return { ok: false, error: `JSON tidak sesuai skema — ${pesan}` }
  }

  return { ok: true, insight: parsed.data }
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text)
  return match?.[1]?.trim() ?? text
}
