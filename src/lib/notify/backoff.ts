import { SendError } from './types'

/**
 * Retry pengiriman — modul murni.
 *
 * Referensi: docs/architecture.md §11
 *
 * Yang diputuskan di sini cuma dua hal, dan keduanya soal sopan santun terhadap
 * layanan orang lain: berapa lama menunggu, dan kapan berhenti mencoba.
 */

export const MAX_SEND_ATTEMPTS = 5
const BASE_DELAY_MS = 1_000
/** Discord membalas 429 dengan jeda yang bisa panjang; jangan tidur semalaman. */
export const MAX_DELAY_MS = 60_000

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  /** Dipakai untuk jitter. Di-inject supaya bisa diuji secara deterministik. */
  random?: () => number
  /** `Retry-After` dari server, kalau ada. Selalu menang atas hitungan sendiri. */
  retryAfterMs?: number | null
}

/**
 * Jeda sebelum percobaan ke-`attempt` (1 = percobaan pertama yang gagal).
 *
 * 1s → 2s → 4s → 8s → 16s, ditambah jitter sampai 25% supaya beberapa kiriman
 * yang gagal bersamaan tidak kembali serentak.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt harus integer >= 1, dapat ${attempt}`)
  }

  const max = options.maxMs ?? MAX_DELAY_MS

  // Server yang menyebutkan sendiri kapan boleh dicoba lagi selalu lebih tahu
  // daripada rumus kita.
  if (options.retryAfterMs != null && options.retryAfterMs > 0) {
    return Math.min(options.retryAfterMs, max)
  }

  const base = options.baseMs ?? BASE_DELAY_MS
  const random = options.random ?? Math.random
  const exponential = base * 2 ** (attempt - 1)
  const jitter = exponential * 0.25 * random()

  return Math.min(Math.round(exponential + jitter), max)
}

export function shouldRetry(error: SendError, attempt: number, maxAttempts = MAX_SEND_ATTEMPTS): boolean {
  if (!error.retryable) return false
  return attempt < maxAttempts
}

/**
 * Terjemahkan jawaban HTTP menjadi keputusan retry.
 *
 * 429 dan 5xx = keadaan sementara, coba lagi.
 * 4xx lain = konfigurasinya yang salah (webhook dihapus, token dicabut);
 * mencoba lagi lima kali hanya menunda pesan gagal yang perlu segera dibaca.
 */
export function sendErrorFromResponse(
  channel: string,
  status: number,
  body: string,
  retryAfterMs: number | null,
): SendError {
  const retryable = status === 429 || status >= 500
  const snippet = body.trim().slice(0, 200)
  return new SendError(
    `${channel} menolak kiriman (HTTP ${status})${snippet ? `: ${snippet}` : ''}`,
    { retryable, status, retryAfterMs },
  )
}

/** Gagal sebelum jawaban diterima: internet toko mati, DNS, timeout. */
export function sendErrorFromNetwork(channel: string, cause: unknown): SendError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new SendError(`${channel} tidak bisa dihubungi: ${detail}`, { retryable: true })
}

/** Header `Retry-After` Discord/Telegram: detik (angka) atau tanggal HTTP. */
export function parseRetryAfter(header: string | null, now: Date): number | null {
  if (!header) return null

  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const at = Date.parse(header)
  if (Number.isNaN(at)) return null

  const delta = at - now.getTime()
  return delta > 0 ? delta : 0
}
