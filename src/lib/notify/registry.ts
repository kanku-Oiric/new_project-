import type { Db } from '../audit'
import { prisma } from '../db/prisma'
import type { ReportChannel } from '../enums'
import { getSetting, type SettingKey } from '../settings'
import { createDiscordProvider } from './providers/discord'
import type { NotifyDeps } from './providers/deps'
import { createTelegramProvider } from './providers/telegram'
import type { NotificationProvider } from './types'

/**
 * Registry saluran notifikasi.
 *
 * WhatsApp sengaja TIDAK ada di sini. `REPORT_CHANNELS` hanya memuat DISCORD
 * dan TELEGRAM, sehingga mendaftarkan WhatsApp akan menjadi error kompilasi —
 * bukan sekadar kesepakatan bahwa kita tidak memakainya
 * (lihat providers/whatsapp.ts).
 */

/** Internet toko bisa menggantung; 15 detik sudah sangat longgar untuk webhook. */
export const SEND_TIMEOUT_MS = 15_000

export function notifyDeps(db: Db = prisma, overrides: Partial<NotifyDeps> = {}): NotifyDeps {
  return {
    readSetting: <K extends SettingKey>(key: K) => getSetting(key, db),
    fetch: (...args) => fetch(...args),
    timeoutSignal: () => AbortSignal.timeout(SEND_TIMEOUT_MS),
    now: () => new Date(),
    ...overrides,
  }
}

export function notificationProvidersFor(
  db: Db = prisma,
  overrides: Partial<NotifyDeps> = {},
): Record<ReportChannel, NotificationProvider> {
  const deps = notifyDeps(db, overrides)
  return {
    DISCORD: createDiscordProvider(deps),
    TELEGRAM: createTelegramProvider(deps),
  }
}

export function notificationProviderFor(
  channel: ReportChannel,
  db: Db = prisma,
  overrides: Partial<NotifyDeps> = {},
): NotificationProvider {
  return notificationProvidersFor(db, overrides)[channel]
}

export function listNotificationProviders(
  db: Db = prisma,
  overrides: Partial<NotifyDeps> = {},
): NotificationProvider[] {
  return Object.values(notificationProvidersFor(db, overrides))
}

/**
 * Saluran yang benar-benar punya kredensial.
 *
 * Catch-up hanya mengirim ke saluran ini. Toko yang belum mengisi apa pun tidak
 * menumpuk baris FAILED setiap kali server menyala — tidak ada yang gagal,
 * memang tidak ada tujuan.
 */
export async function configuredChannels(
  db: Db = prisma,
  overrides: Partial<NotifyDeps> = {},
): Promise<ReportChannel[]> {
  const providers = listNotificationProviders(db, overrides)
  const out: ReportChannel[] = []
  for (const p of providers) {
    if (await p.isConfigured()) out.push(p.channel)
  }
  return out
}
