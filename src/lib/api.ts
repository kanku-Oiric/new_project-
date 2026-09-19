import 'server-only'
import { NextResponse } from 'next/server'
import { ZodError, type TypeOf, type ZodTypeAny } from 'zod'
import { AppError, ValidationError, describeError, isAppError } from './errors'
import { createLogger } from './logger'

const log = createLogger('api')

/**
 * Pola wajib setiap route handler:
 *   withAuth(role) → parseBody(schema, req) → service → handleApiError
 *
 * Error envelope seragam: { error: { code, message, details? } }
 */

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

/**
 * Validasi body JSON dengan Zod. Semua input client lewat sini.
 *
 * Generiknya mengikat SCHEMA lalu menurunkan tipenya lewat `TypeOf`, bukan
 * mengikat tipe hasil langsung. Bedanya nyata: dengan `ZodType<T>`, schema yang
 * memakai `.default()` membuat TypeScript menyimpulkan tipe INPUT (field
 * opsional) alih-alih tipe OUTPUT (field sudah terisi default).
 */
export async function parseBody<S extends ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<TypeOf<S>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new ValidationError('Body request bukan JSON yang valid')
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new ValidationError('Data yang dikirim tidak valid', fieldIssues(result.error))
  }
  return result.data
}

/** Validasi query string dengan Zod. */
export function parseQuery<S extends ZodTypeAny>(req: Request, schema: S): TypeOf<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries())
  const result = schema.safeParse(params)
  if (!result.success) {
    throw new ValidationError('Parameter tidak valid', fieldIssues(result.error))
  }
  return result.data
}

function fieldIssues(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_'
    // Pesan pertama per field sudah cukup untuk ditampilkan ke kasir.
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

/**
 * Ubah error apa pun menjadi response.
 *
 * Error tak terduga di-log LENGKAP dengan stack di server, tapi client hanya
 * menerima pesan umum — bocornya detail internal ke layar kasir tidak membantu
 * siapa pun. Yang penting: tidak ada exception yang hilang tanpa jejak.
 */
export function handleApiError(e: unknown, scope: string): NextResponse<ApiErrorBody> {
  if (isAppError(e)) {
    // Error yang memang bagian dari alur (PIN salah, stok konflik) cukup dicatat
    // ringkas; ini bukan kerusakan sistem.
    if (e.httpStatus >= 500) {
      log.error(`${scope} gagal`, e)
    } else {
      log.warn(`${scope}: ${e.code} — ${e.message}`)
    }
    return NextResponse.json<ApiErrorBody>(
      {
        error: {
          code: e.code,
          message: e.message,
          ...(e.details === undefined ? {} : { details: e.details }),
        },
      },
      { status: e.httpStatus },
    )
  }

  log.error(`${scope} melempar error tak terduga`, e)
  if (!(e instanceof Error)) {
    log.error(`${scope} nilai yang dilempar bukan Error`, undefined, {
      thrown: describeError(e),
    })
  }

  return NextResponse.json<ApiErrorBody>(
    {
      error: {
        code: 'INTERNAL',
        message: 'Terjadi kesalahan di server. Coba lagi, atau hubungi pemilik.',
      },
    },
    { status: 500 },
  )
}

/** Bungkus handler supaya semua error lewat handleApiError. */
export function route<Args extends unknown[]>(
  scope: string,
  handler: (req: Request, ...args: Args) => Promise<NextResponse>,
): (req: Request, ...args: Args) => Promise<NextResponse> {
  return async (req, ...args) => {
    try {
      return await handler(req, ...args)
    } catch (e) {
      return handleApiError(e, scope)
    }
  }
}

export function ok<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status })
}

/** Alamat IP untuk audit log. Server LAN, jadi header proxy tidak dipercaya. */
export function clientIp(req: Request): string | null {
  const direct = req.headers.get('x-forwarded-for')
  if (!direct) return null
  const first = direct.split(',')[0]
  return first ? first.trim() : null
}

export function deviceLabel(req: Request): string | null {
  const ua = req.headers.get('user-agent')
  if (!ua) return null
  return ua.slice(0, 120)
}

export function isAppErrorStatus(e: unknown): e is AppError {
  return isAppError(e)
}
