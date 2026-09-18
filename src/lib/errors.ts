/**
 * Hirarki error bertipe.
 *
 * Aturan: tidak ada exception yang ditelan diam-diam. Setiap error yang sampai
 * ke handler HTTP di-log lengkap di server, lalu dikembalikan ke client sebagai
 * `{ error: { code, message, details? } }` dengan pesan yang aman dibaca kasir.
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LOCKED'
  | 'NOT_CONFIGURED'
  | 'INTERNAL'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly details?: unknown

  constructor(code: ErrorCode, httpStatus: number, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }
}

/** Input dari client tidak lolos Zod. */
export class ValidationError extends AppError {
  constructor(message = 'Data yang dikirim tidak valid', details?: unknown) {
    super('VALIDATION', 400, message, details)
  }
}

/** Belum login, atau session kedaluwarsa. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Silakan login terlebih dahulu') {
    super('UNAUTHENTICATED', 401, message)
  }
}

/** Sudah login tapi tidak berhak — termasuk PIN owner yang salah. */
export class ForbiddenError extends AppError {
  constructor(message = 'Tidak punya akses untuk tindakan ini') {
    super('FORBIDDEN', 403, message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Data tidak ditemukan') {
    super('NOT_FOUND', 404, message)
  }
}

/**
 * Benturan state — dipakai oleh guarded update. Contohnya dua kasir menekan
 * "Pembayaran diterima" bersamaan: yang kedua mendapat error ini, bukan
 * diam-diam memproses ulang.
 */
export class ConflictError extends AppError {
  constructor(message = 'Data sudah berubah, muat ulang halaman') {
    super('CONFLICT', 409, message)
  }
}

/** Akun terkunci karena terlalu banyak PIN salah. */
export class LockedError extends AppError {
  constructor(message: string) {
    super('LOCKED', 429, message)
  }
}

/**
 * Integrasi luar belum dikonfigurasi. Dipakai stub WhatsApp dan provider yang
 * kredensialnya kosong — supaya sistem tidak pernah mengklaim tersambung.
 */
export class NotConfiguredError extends AppError {
  constructor(message: string) {
    super('NOT_CONFIGURED', 503, message)
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/** Pesan error untuk log, tanpa kehilangan informasi. */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    return e.stack ?? `${e.name}: ${e.message}`
  }
  try {
    return `non-Error thrown: ${JSON.stringify(e)}`
  } catch {
    return `non-Error thrown: ${String(e)}`
  }
}
