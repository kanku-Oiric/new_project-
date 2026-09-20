import type { AiPayload } from './payload'

/**
 * Klien Gemini.
 *
 * Satu-satunya tempat di seluruh sistem yang menghubungi layanan AI. Tidak ada
 * jalur lain, dan tidak ada yang memanggilnya di luar `src/lib/ai/service.ts` —
 * penegakan batas 1×/hari akan tidak berarti kalau ada pintu kedua.
 *
 * `fetch` di-inject supaya seluruh perilaku (gagal, lambat, jawaban ngawur) bisa
 * diuji tanpa satu pun request ke internet. Test yang menembak Google sungguhan
 * bukan test, ia tagihan.
 */

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_TIMEOUT_MS = 20_000

export class AiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'AiError'
    this.status = status
  }
}

export interface GeminiOptions {
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Prompt.
 *
 * Tiga larangan di dalamnya bukan formalitas: model yang mengarang angka akan
 * menghasilkan laporan yang terlihat meyakinkan dan salah, dan pemilik toko
 * tidak punya cara memeriksanya selain membuka laporan lain.
 */
function buildPrompt(payload: AiPayload): string {
  return [
    'Kamu menganalisis data penjualan sebuah toko kelontong kecil di Indonesia.',
    '',
    'Aturan:',
    '1. HANYA gunakan angka yang ada di data di bawah. Jangan menghitung ulang',
    '   dengan asumsi, jangan mengarang angka, jangan menyebut periode lain.',
    '2. Kalau data tidak cukup untuk sebuah kesimpulan, katakan begitu apa adanya.',
    '3. Jangan sebut "laba bersih" — biaya di luar HPP tidak tercatat lengkap,',
    '   jadi angka itu tidak ada di data ini.',
    '',
    'Tulis dalam bahasa Indonesia yang sederhana, seperti menjelaskan kepada',
    'pemilik toko yang bukan orang keuangan. Hindari istilah teknis.',
    '',
    'Jawab HANYA dengan JSON, tanpa blok kode, dengan bentuk tepat seperti ini:',
    '{"ringkasan":"...","temuan":["..."],"saran":["..."]}',
    '',
    'ringkasan: 2-3 kalimat keadaan periode ini.',
    'temuan   : 1-5 hal yang terlihat dari angkanya.',
    'saran    : 1-5 tindakan konkret yang bisa dilakukan pemilik toko.',
    '',
    'Data:',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

/**
 * Panggil Gemini, kembalikan teks mentahnya.
 *
 * Melempar `AiError` kalau gagal. Pemanggilnya yang memutuskan apa artinya —
 * di sistem ini artinya: catat, lewati bagian AI, dan kirim laporannya tanpa itu.
 */
export async function callGemini(payload: AiPayload, opts: GeminiOptions): Promise<string> {
  if (!opts.apiKey) throw new AiError('GEMINI_API_KEY belum diisi')

  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const res = await doFetch(`${ENDPOINT_BASE}/${encodeURIComponent(opts.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header, BUKAN query string. Kunci API di URL akan ikut tercatat di log
        // akses, di pesan error, dan di riwayat — tiga tempat yang tidak pernah
        // dimaksudkan menyimpan rahasia.
        'x-goog-api-key': opts.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(payload) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4,
          maxOutputTokens: 900,
        },
      }),
      signal: controller.signal,
    })

    const body = await res.text()

    if (!res.ok) {
      throw new AiError(`Gemini menjawab ${res.status}: ${redact(body, opts.apiKey)}`, res.status)
    }

    const text = extractText(body)
    if (text === null) {
      throw new AiError('Jawaban Gemini tidak memuat teks yang bisa dibaca', res.status)
    }
    return text
  } catch (e) {
    if (e instanceof AiError) throw e
    if (e instanceof Error && e.name === 'AbortError') {
      throw new AiError(`Gemini tidak menjawab dalam ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)
    }
    throw new AiError(redact(e instanceof Error ? e.message : String(e), opts.apiKey))
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Buang kunci API dari teks apa pun yang akan dicatat.
 *
 * Pesan error berakhir di `ai_call_logs`, di berkas log, dan di layar pemilik.
 * Tidak satu pun dari ketiganya tempat yang pantas memuat kunci API.
 */
function redact(text: string, apiKey: string): string {
  const potong = text.slice(0, 500)
  return apiKey ? potong.replaceAll(apiKey, '<api-key>') : potong
}

/**
 * Ambil teks dari bentuk response Gemini, tanpa mempercayai bentuknya.
 *
 * Dibaca dengan pemeriksaan bertahap alih-alih `as`: response dari luar adalah
 * data yang tidak dikendalikan sistem ini, dan `as` hanya membuat TypeScript
 * berhenti bertanya tanpa membuat datanya benar.
 */
function extractText(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const candidates = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return null

  const first = candidates[0]
  if (typeof first !== 'object' || first === null) return null

  const content = (first as { content?: unknown }).content
  if (typeof content !== 'object' || content === null) return null

  const parts = (content as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return null

  const teks = parts
    .map((p) => (typeof p === 'object' && p !== null ? (p as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string')
    .join('')

  return teks.length > 0 ? teks : null
}
