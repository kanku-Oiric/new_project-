import { z } from 'zod'
import { recordAudit, type AuditActor, type Db } from './audit'
import { prisma } from './db/prisma'
import { ValidationError } from './errors'

/**
 * Settings disimpan sebagai key → string, lalu di-parse per key lewat Zod.
 * Definisi di file ini adalah satu-satunya tempat default dan tipe ditentukan.
 *
 * Yang TIDAK ada di sini: GEMINI_API_KEY. Kunci itu hanya dari env, tidak pernah
 * dari DB, dan tidak pernah dikirim ke client (docs/architecture.md §12).
 */

const boolString = z
  .string()
  .transform((v) => v === 'true')
  .pipe(z.boolean())

/**
 * Daftar string yang tersimpan sebagai JSON.
 *
 * `ctx.addIssue` + `z.NEVER`, BUKAN `throw`. Bedanya menentukan apakah halaman
 * hidup atau 500:
 *
 *   `safeParse` milik Zod TIDAK menangkap exception yang dilempar dari dalam
 *   `.transform()`. Versi sebelumnya memanggil `JSON.parse(v)` langsung di sana,
 *   sehingga satu baris setting yang kosong membuat `getSetting` MELEMPAR —
 *   padahal seluruh gunanya `safeParse` di sana adalah supaya nilai rusak jatuh
 *   ke default.
 *
 * Ketahuan dari log server saat pemeriksaan manual:
 *   `SyntaxError: Unexpected end of JSON input ... GET /pengaturan 500`.
 */
const jsonStringArray = z.string().transform((v, ctx) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(v)
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bukan JSON yang sah' })
    return z.NEVER
  }

  const arr = z.array(z.string()).safeParse(parsed)
  if (!arr.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'harus berupa array of string' })
    return z.NEVER
  }
  return arr.data
})

/**
 * Peta jenis jasa → biaya admin bawaan.
 *
 * Bentuknya sama hati-hatinya dengan `jsonStringArray`: JSON.parse dibungkus
 * `ctx.addIssue`, bukan dilempar dari dalam `.transform()`. Satu nilai aneh di
 * sini tidak boleh membuat layar kasir gagal dibuka — dan itu persis yang
 * pernah terjadi (BUG-03).
 *
 * Nilai per jenis yang tidak masuk akal disaring lagi di `feeDefaults()`, jadi
 * skema ini cukup memastikan bentuknya objek angka.
 */
const jsonNumberMap = z.string().transform((v, ctx) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(v)
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bukan JSON yang sah' })
    return z.NEVER
  }

  const obj = z.record(z.string(), z.number()).safeParse(parsed)
  if (!obj.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'harus berupa objek angka' })
    return z.NEVER
  }
  return obj.data
})

export const SETTING_DEFS = {
  storeName: { schema: z.string().min(1), default: 'Toko Saya', secret: false },
  storeAddress: { schema: z.string(), default: '', secret: false },
  storePhone: { schema: z.string(), default: '', secret: false },
  receiptFooter: { schema: z.string(), default: 'Terima kasih', secret: false },
  receiptWidth: { schema: z.enum(['58', '80', 'a4']), default: '80', secret: false },

  timezone: { schema: z.string().min(1), default: 'Asia/Jakarta', secret: false },
  /**
   * Kosong sampai server pertama kali menyala. Nilai kosong HARUS sah menurut
   * schema-nya: kalau tidak, `getSetting` jatuh ke `parse(default)` dan justru
   * melempar untuk setting yang belum pernah diisi — persis keadaan yang
   * fallback itu dimaksudkan untuk menyelamatkan.
   */
  installDate: {
    schema: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
    default: '',
    secret: false,
  },

  qrisEnabled: { schema: boolString, default: 'false', secret: false },

  discordWebhookUrl: { schema: z.string(), default: '', secret: true },
  telegramBotToken: { schema: z.string(), default: '', secret: true },
  /**
   * Chat id Telegram — dua bentuk yang diterima Telegram, dan hanya dua.
   *
   *   -1001234567890   id numerik (grup/channel selalu negatif, personal positif)
   *   @namachannel     username publik, dan bot HARUS sudah menjadi anggota
   *
   * Divalidasi di sini karena kesalahan yang paling sering terjadi hanya terlihat
   * SAAT pengiriman gagal: Telegram menjawab `chat not found` untuk username yang
   * tidak publik, tidak ada, atau belum dimasuki bot — dan pesan itu baru muncul
   * berjam-jam kemudian saat laporan otomatis dikirim.
   */
  telegramChatId: {
    schema: z.union([
      z.literal(''),
      z
        .string()
        .regex(
          /^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/,
          'Chat id harus berupa angka (mis. -1001234567890) atau @namachannel publik yang botnya sudah menjadi anggota',
        ),
    ]),
    default: '',
    secret: false,
  },

  reportDailyTime: { schema: z.string().regex(/^\d{2}:\d{2}$/), default: '21:00', secret: false },
  reportWeeklyDay: { schema: z.coerce.number().int().min(1).max(7), default: '1', secret: false },
  reportMonthlyDay: { schema: z.coerce.number().int().min(1).max(28), default: '1', secret: false },
  catchUpMaxPeriods: {
    schema: z.coerce.number().int().min(1).max(400),
    default: '60',
    secret: false,
  },

  lowStockAlert: { schema: boolString, default: 'true', secret: false },
  expenseCategories: {
    schema: jsonStringArray,
    default: JSON.stringify([
      'Kasbon',
      'Gaji',
      'Listrik',
      'Air',
      'Transport',
      'Operasional',
      'Pembelian Barang',
      'Lainnya',
    ]),
    secret: false,
  },
  /** Biaya admin bawaan per jenis jasa. Kosong = pakai angka di katalog. */
  serviceFeeDefaults: { schema: jsonNumberMap, default: '{}', secret: false },
} as const

export type SettingKey = keyof typeof SETTING_DEFS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFS)[K]['schema']>

export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[]

export function isSecretKey(key: SettingKey): boolean {
  return SETTING_DEFS[key].secret
}

/**
 * Baca satu setting. Kalau baris tidak ada atau nilainya rusak, kembalikan
 * default — sistem tidak boleh berhenti jualan karena satu setting cacat.
 */
export async function getSetting<K extends SettingKey>(
  key: K,
  db: Db = prisma,
): Promise<SettingValue<K>> {
  const def = SETTING_DEFS[key]
  const row = await db.setting.findUnique({ where: { key } })
  const raw = row?.value ?? def.default

  // try/catch, bukan hanya safeParse.
  //
  // Lapis kedua: `safeParse` Zod tidak menangkap exception dari dalam
  // `.transform()`, jadi skema yang melempar akan melewati jaring ini tanpa
  // terlihat. Skema `expenseCategories` pernah begitu dan menjatuhkan
  // /pengaturan dengan 500. Skema-skemanya sudah diperbaiki agar tidak melempar,
  // tapi jaring ini tetap dipasang: satu baris setting cacat tidak boleh pernah
  // menghentikan toko berjualan, apa pun bentuk cacatnya.
  try {
    const parsed = def.schema.safeParse(raw)
    if (parsed.success) return parsed.data as SettingValue<K>
  } catch {
    // Jatuh ke default di bawah.
  }

  return def.schema.parse(def.default) as SettingValue<K>
}

/** Tulis satu setting. Audit dilakukan pemanggil supaya `before` tetap akurat. */
export async function setSetting<K extends SettingKey>(
  key: K,
  rawValue: string,
  actorId: string | null,
  db: Db = prisma,
): Promise<void> {
  // Validasi sebelum menulis — nilai yang tidak lolos tidak boleh masuk DB.
  SETTING_DEFS[key].schema.parse(rawValue)
  await db.setting.upsert({
    where: { key },
    create: { key, value: rawValue, updatedByUserId: actorId },
    update: { value: rawValue, updatedByUserId: actorId },
  })
}

/** Nilai mentah semua setting, untuk halaman pengaturan. */
export async function getAllSettingsRaw(db: Db = prisma): Promise<Record<SettingKey, string>> {
  const rows = await db.setting.findMany()
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const out = {} as Record<SettingKey, string>
  for (const key of SETTING_KEYS) {
    out[key] = byKey.get(key) ?? SETTING_DEFS[key].default
  }
  return out
}

/**
 * Samarkan secret sebelum dikirim ke client. Menampilkan hanya 4 karakter
 * terakhir supaya pemilik bisa mengenali nilai yang tersimpan tanpa
 * mengeksposnya ke layar yang mungkin terlihat orang lain.
 */
export function maskSecret(value: string): string {
  if (value.length === 0) return ''
  if (value.length <= 4) return '••••'
  return `••••${value.slice(-4)}`
}

export interface SettingsActor extends AuditActor {
  userId: string
  /** Pemilik yang PIN-nya sudah diverifikasi server. */
  authorizedByUserId: string
}

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key)
}

/**
 * Ubah beberapa setting sekaligus.
 *
 * Aturan yang ditegakkan di sini, bukan di UI:
 *  - key yang tidak dikenal ditolak, bukan disimpan sebagai baris liar;
 *  - nilainya wajib lolos schema key-nya sebelum menyentuh database;
 *  - QRIS tidak bisa dinyalakan tanpa gambar QR — kalau bisa, kasir menghadap
 *    layar kosong sementara pelanggan menunggu;
 *  - nilai rahasia (webhook, token) ditulis ke audit log dalam bentuk tersamar.
 *    Audit log dibaca pemilik, tapi ia bukan tempat menyimpan kredensial.
 */
export async function updateSettings(
  values: Record<string, string>,
  actor: SettingsActor,
): Promise<{ changed: SettingKey[] }> {
  const entries: [SettingKey, string][] = []

  for (const [key, value] of Object.entries(values)) {
    if (!isSettingKey(key)) {
      throw new ValidationError(`Pengaturan tidak dikenal: ${key}`)
    }
    const parsed = SETTING_DEFS[key].schema.safeParse(value)
    if (!parsed.success) {
      throw new ValidationError(
        `Nilai pengaturan "${key}" tidak sah: ${parsed.error.issues[0]?.message ?? 'tidak valid'}`,
      )
    }
    entries.push([key, value])
  }

  if (entries.length === 0) {
    throw new ValidationError('Tidak ada pengaturan yang dikirim')
  }

  const before = await getAllSettingsRaw()

  // Dulu di sini ada pemeriksaan silang antar-setting: "gambar QR harus ada
  // sebelum QRIS boleh dinyalakan", yang butuh gabungan nilai lama dan baru.
  // Syarat itu hilang bersama gambarnya — QR soundbox tertempel di meja dan
  // tidak pernah ditampilkan di layar, jadi tidak ada berkas yang bisa
  // diunggah maupun diperiksa. Yang menggantikannya kenyataan fisik: kalau
  // kotaknya belum terpasang, pemiliknya tidak akan menyalakan QRIS.

  const changed: SettingKey[] = []

  await prisma.$transaction(async (tx) => {
    for (const [key, value] of entries) {
      if (before[key] === value) continue

      await tx.setting.upsert({
        where: { key },
        create: { key, value, updatedByUserId: actor.userId },
        update: { value, updatedByUserId: actor.userId },
      })

      const secret = isSecretKey(key)
      await recordAudit(tx, actor, {
        action: 'SETTING_CHANGE',
        summary: `Pengaturan "${key}" diubah`,
        entityType: 'Setting',
        entityId: key,
        before: { value: secret ? maskSecret(before[key]) : before[key] },
        after: {
          value: secret ? maskSecret(value) : value,
          authorizedByUserId: actor.authorizedByUserId,
        },
      })

      changed.push(key)
    }
  })

  return { changed }
}

/** Tulis semua default yang belum ada. Idempoten — aman dijalankan berkali-kali. */
export async function ensureDefaultSettings(
  installDate: string,
  db: Db = prisma,
): Promise<number> {
  let created = 0
  for (const key of SETTING_KEYS) {
    const def = SETTING_DEFS[key]
    const value = key === 'installDate' ? installDate : def.default
    const existing = await db.setting.findUnique({ where: { key } })
    if (!existing) {
      await db.setting.create({ data: { key, value } })
      created++
    }
  }
  return created
}
