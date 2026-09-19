import { MAX_SEND_ATTEMPTS, backoffDelayMs, shouldRetry } from './backoff'
import { SendError, type NotificationProvider, type ReportMessage } from './types'

/**
 * Kirim dengan percobaan ulang.
 *
 * Fungsi ini TIDAK PERNAH melempar. Kegagalan mengirim laporan tidak boleh
 * merambat ke pemanggilnya, karena pemanggilnya bisa jadi proses startup —
 * dan toko yang tidak bisa jualan gara-gara webhook Discord mati adalah
 * kegagalan yang jauh lebih mahal daripada laporan yang telat
 * (docs/architecture.md §11).
 */

export interface SendOutcome {
  ok: boolean
  attempts: number
  error: string | null
  /** true kalau berhenti karena percuma dicoba lagi, bukan karena kehabisan jatah. */
  permanent: boolean
}

export interface SendWithRetryOptions {
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Dipanggil tiap percobaan gagal, untuk log. */
  onAttemptFailed?: (attempt: number, error: SendError, waitMs: number | null) => void
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function toSendError(e: unknown): SendError {
  if (e instanceof SendError) return e
  // Error tak terduga (bug di provider, JSON gagal di-serialize) diperlakukan
  // sebagai permanen: mengulanginya lima kali tidak akan mengubah hasilnya.
  return new SendError(e instanceof Error ? e.message : String(e), { retryable: false })
}

export async function sendWithRetry(
  provider: NotificationProvider,
  message: ReportMessage,
  options: SendWithRetryOptions = {},
): Promise<SendOutcome> {
  const maxAttempts = options.maxAttempts ?? MAX_SEND_ATTEMPTS
  const sleep = options.sleep ?? realSleep

  let attempt = 0
  let lastError: SendError | null = null

  while (attempt < maxAttempts) {
    attempt++
    try {
      await provider.send(message)
      return { ok: true, attempts: attempt, error: null, permanent: false }
    } catch (e) {
      const error = toSendError(e)
      lastError = error

      if (!shouldRetry(error, attempt, maxAttempts)) {
        options.onAttemptFailed?.(attempt, error, null)
        return {
          ok: false,
          attempts: attempt,
          error: error.message,
          permanent: !error.retryable,
        }
      }

      const waitMs = backoffDelayMs(attempt, {
        random: options.random,
        retryAfterMs: error.retryAfterMs,
      })
      options.onAttemptFailed?.(attempt, error, waitMs)
      await sleep(waitMs)
    }
  }

  return {
    ok: false,
    attempts: attempt,
    error: lastError?.message ?? 'gagal tanpa keterangan',
    permanent: false,
  }
}
