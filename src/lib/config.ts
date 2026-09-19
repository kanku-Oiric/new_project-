import path from 'node:path'
import { z } from 'zod'
import { DEFAULT_TIMEZONE } from './time'

/**
 * Konfigurasi dari environment, divalidasi sekali saat modul dimuat.
 *
 * Yang ADA di sini hanyalah hal yang tidak boleh diubah lewat UI: lokasi DB,
 * zona waktu, dan kredensial Gemini. Webhook Discord dan token Telegram justru
 * TIDAK di sini — keduanya di tabel settings supaya pemilik bisa mengisinya
 * tanpa menyentuh file (docs/database.md §6).
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TIMEZONE: z.string().min(1).default(DEFAULT_TIMEZONE),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(500).default(30),
  BACKUP_MIRROR_DIR: z.string().optional(),
  /**
   * Folder backup. Dialihkan oleh test supaya `VACUUM INTO` di dalam test tidak
   * menaruh berkas berisi data UJI ke dalam folder backup toko — berkas seperti
   * itu tidak bisa dibedakan dari backup sungguhan saat dibutuhkan.
   */
  BACKUP_DIR: z.string().optional(),
  /**
   * Folder gambar unggahan. Bisa dialihkan supaya test HTTP tidak menulis ke
   * folder data toko, dan supaya pemilik bisa menaruhnya di drive lain.
   */
  UPLOADS_DIR: z.string().optional(),
  AI_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
})

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  // Konfigurasi yang salah harus berhenti keras dan jelas saat boot, bukan
  // menghasilkan perilaku aneh jam 8 pagi saat toko buka.
  throw new Error(
    `Konfigurasi environment tidak valid:\n${parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')}`,
  )
}

const env = parsed.data

/** Akar project, dasar semua path absolut. */
export const ROOT_DIR = process.cwd()

export const config = {
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  /** Zona waktu toko — dasar seluruh perhitungan businessDate. */
  timezone: env.TIMEZONE,

  paths: {
    data: path.join(ROOT_DIR, 'data'),
    /** File DB SQLite. Harus cocok dengan DATABASE_URL di prisma/schema.prisma. */
    database: path.join(ROOT_DIR, 'data', 'pos.db'),
    uploads: env.UPLOADS_DIR?.trim()
      ? path.resolve(ROOT_DIR, env.UPLOADS_DIR.trim())
      : path.join(ROOT_DIR, 'data', 'uploads'),
    logs: path.join(ROOT_DIR, 'data', 'logs'),
    backups: env.BACKUP_DIR?.trim()
      ? path.resolve(ROOT_DIR, env.BACKUP_DIR.trim())
      : path.join(ROOT_DIR, 'backups'),
  },

  backup: {
    keep: env.BACKUP_KEEP,
    mirrorDir: env.BACKUP_MIRROR_DIR?.trim() ? env.BACKUP_MIRROR_DIR.trim() : null,
  },

  ai: {
    /** Gerbang utama. Default MATI. */
    enabled: env.AI_ENABLED,
    /** HANYA dari env. Tidak pernah dari DB, tidak pernah dikirim ke client. */
    apiKey: env.GEMINI_API_KEY?.trim() ?? '',
    model: env.GEMINI_MODEL?.trim() || 'gemini-2.0-flash',
  },

  auth: {
    sessionCookieName: 'kasir_session',
    /** Sliding expiry. Cukup untuk satu shift panjang tanpa login ulang. */
    sessionTtlHours: 12,
    bcryptRounds: 10,
    maxFailedAttempts: 5,
    lockoutMinutes: 5,
  },
} as const

/**
 * AI dianggap benar-benar siap hanya kalau gerbangnya nyala DAN kuncinya ada.
 * Tidak pernah mengklaim siap hanya karena AI_ENABLED=true.
 */
export function isAiConfigured(): boolean {
  return config.ai.enabled && config.ai.apiKey.length > 0
}
