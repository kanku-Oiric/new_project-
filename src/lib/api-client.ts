/**
 * Klasifikasi hasil request dari sisi browser.
 *
 * Membedakan tiga keadaan yang sering dicampur menjadi satu pesan, padahal
 * tindakan yang benar untuk kasir berbeda-beda:
 *
 *   network-error  request tidak pernah sampai, ATAU sampai tapi jawabannya
 *                  tidak diterima. Dari browser keduanya tidak bisa dibedakan,
 *                  jadi untuk request yang mengubah data kasir HARUS diminta
 *                  memeriksa riwayat sebelum mengulang.
 *   server-error   server menjawab 5xx. Requestnya SAMPAI. Checkout kita
 *                  di-rollback pada kegagalan, tapi kepastian itu ada di
 *                  server — dari sisi kasir tetap harus diperiksa dulu.
 *   client-error   server menjawab 4xx. Datanya yang salah; aman diperbaiki
 *                  lalu diulang.
 *
 * Bug yang melatarbelakangi file ini: dulu `await res.json()` dipanggil tanpa
 * pengaman. Ketika server membalas 500 dengan halaman HTML, parsing JSON
 * melempar, lemparannya jatuh ke blok catch jaringan, dan kasir membaca
 * "Koneksi terputus" padahal server menjawab dengan baik. Pesan yang salah
 * menuntun ke tindakan yang salah.
 */

export type ApiOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'client-error'; status: number; code: string; message: string }
  | { kind: 'server-error'; status: number; message: string }
  | { kind: 'network-error'; message: string }

interface ErrorEnvelope {
  code: string
  message: string
}

/** Ambil `{ error: { code, message } }` kalau bentuknya memang itu. */
export function readErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null
  const error = (body as { error: unknown }).error
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { message?: unknown }).message
  const code = (error as { code?: unknown }).code
  if (typeof message !== 'string') return null
  return { code: typeof code === 'string' ? code : 'UNKNOWN', message }
}

/**
 * Klasifikasikan response yang SUDAH diterima. Fungsi murni — tidak melakukan
 * IO, sehingga seluruh cabangnya bisa diuji tanpa server.
 *
 * `body` adalah hasil parsing JSON, atau `undefined` kalau body bukan JSON
 * (misalnya halaman error HTML). Body yang tidak bisa di-parse BUKAN alasan
 * melaporkan kegagalan jaringan.
 */
export function classifyResponse<T>(
  status: number,
  body: unknown,
  bodyWasJson: boolean,
): ApiOutcome<T> {
  if (status >= 200 && status < 300) {
    if (!bodyWasJson) {
      return {
        kind: 'server-error',
        status,
        message: `Server menjawab ${status} tetapi isinya tidak bisa dibaca.`,
      }
    }
    return { kind: 'ok', data: body as T }
  }

  const envelope = readErrorEnvelope(body)

  if (status >= 500) {
    return {
      kind: 'server-error',
      status,
      message: envelope?.message ?? `Server mengalami kesalahan (HTTP ${status}).`,
    }
  }

  return {
    kind: 'client-error',
    status,
    code: envelope?.code ?? 'UNKNOWN',
    message: envelope?.message ?? `Permintaan ditolak (HTTP ${status}).`,
  }
}

/**
 * Pesan siap tampil untuk kasir, sesuai tindakan yang benar per keadaan.
 *
 * `retrySafe` menandai request yang membawa kunci sekali-pakai
 * (src/lib/idempotency.ts). Bedanya besar bagi kasir yang sedang menghadapi
 * pelanggan:
 *
 *   tanpa kunci  "JANGAN ulangi — periksa riwayat dulu". Benar, tapi berat:
 *                di tengah antrean, kasir harus membuka halaman lain dan
 *                mencari transaksi yang mungkin ada.
 *   dengan kunci "Coba lagi". Server akan mengembalikan transaksi yang sama
 *                kalau ternyata sudah tersimpan, jadi tidak ada penjualan kedua
 *                yang bisa tercipta.
 *
 * Defaultnya `false` dengan sengaja: pemanggil harus MENYATAKAN bahwa ia
 * mengirim kunci. Kalau lupa, yang muncul adalah peringatan yang lebih hati-hati,
 * bukan janji aman yang tidak ditopang apa pun.
 */
export function outcomeMessage(
  outcome: ApiOutcome<unknown>,
  mutating: boolean,
  retrySafe = false,
): string {
  const advice = retrySafe
    ? 'Coba lagi — kalau transaksinya ternyata sudah tersimpan, sistem mengembalikan transaksi yang sama dan tidak mencatatnya dua kali.'
    : 'JANGAN ulangi pembayaran — periksa dulu di riwayat transaksi apakah transaksi ini sudah tersimpan.'

  switch (outcome.kind) {
    case 'ok':
      return ''
    case 'client-error':
      return outcome.message
    case 'server-error':
      return mutating ? `${outcome.message} ${advice}` : outcome.message
    case 'network-error':
      return mutating ? `${outcome.message} ${advice}` : outcome.message
  }
}

async function readBody(res: Response): Promise<{ body: unknown; wasJson: boolean }> {
  try {
    return { body: await res.json(), wasJson: true }
  } catch {
    // Halaman error HTML, body kosong, atau JSON rusak. Ini keadaan yang sah
    // untuk dilaporkan sebagai error server — bukan error jaringan.
    return { body: undefined, wasJson: false }
  }
}

/** GET yang mengembalikan hasil terklasifikasi, bukan melempar. */
export async function getJson<T>(url: string): Promise<ApiOutcome<T>> {
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    return {
      kind: 'network-error',
      message: 'Tidak bisa menghubungi server. Periksa koneksi WiFi ke komputer kasir.',
    }
  }
  const { body, wasJson } = await readBody(res)
  return classifyResponse<T>(res.status, body, wasJson)
}

async function sendJson<T>(
  method: 'POST' | 'PATCH',
  url: string,
  payload: unknown,
): Promise<ApiOutcome<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return {
      kind: 'network-error',
      message: 'Tidak ada jawaban dari server.',
    }
  }
  const { body, wasJson } = await readBody(res)
  return classifyResponse<T>(res.status, body, wasJson)
}

/** POST JSON yang mengembalikan hasil terklasifikasi, bukan melempar. */
export async function postJson<T>(url: string, payload: unknown): Promise<ApiOutcome<T>> {
  return sendJson<T>('POST', url, payload)
}

export async function patchJson<T>(url: string, payload: unknown): Promise<ApiOutcome<T>> {
  return sendJson<T>('PATCH', url, payload)
}

/**
 * POST multipart, untuk unggah berkas.
 *
 * `Content-Type` sengaja TIDAK diisi: browser harus menuliskannya sendiri
 * lengkap dengan boundary, dan mengisinya manual justru merusak parsing di
 * server.
 */
export async function postForm<T>(url: string, form: FormData): Promise<ApiOutcome<T>> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: form })
  } catch {
    return { kind: 'network-error', message: 'Tidak ada jawaban dari server.' }
  }
  const { body, wasJson } = await readBody(res)
  return classifyResponse<T>(res.status, body, wasJson)
}
