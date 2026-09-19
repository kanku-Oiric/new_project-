import {
  parseRetryAfter,
  sendErrorFromNetwork,
  sendErrorFromResponse,
} from '../backoff'
import type { NotificationProvider, ReportMessage, ProviderReadiness } from '../types'
import type { NotifyDeps } from './deps'

/**
 * Discord lewat webhook.
 *
 * Webhook dipilih daripada bot karena tidak butuh OAuth, tidak butuh server
 * menerima koneksi masuk, dan pemilik bisa membuatnya sendiri dari menu
 * Server Settings tanpa mendaftarkan aplikasi apa pun.
 */

const DISCORD_LIMIT_FIELDS = 25
const DISCORD_LIMIT_VALUE = 1024
const DISCORD_COLOR = 0x2e7d32

export function embedFromMessage(message: ReportMessage): Record<string, unknown> {
  // Satu field per section, isinya baris-baris "label: value". Ini lebih tahan
  // terhadap batas 25 field daripada satu field per baris.
  const fields = message.sections.slice(0, DISCORD_LIMIT_FIELDS).map((section) => ({
    name: section.label,
    value:
      section.rows
        .map((r) => (r.emphasis ? `**${r.label}: ${r.value}**` : `${r.label}: ${r.value}`))
        .join('\n')
        .slice(0, DISCORD_LIMIT_VALUE) || '—',
    inline: false,
  }))

  if (message.aiInsight) {
    fields.push({
      name: 'Analisis',
      value: message.aiInsight.slice(0, DISCORD_LIMIT_VALUE),
      inline: false,
    })
  }

  return {
    title: message.title,
    description: message.periodLabel,
    color: DISCORD_COLOR,
    fields,
    ...(message.footnotes?.length
      ? { footer: { text: message.footnotes.join(' · ').slice(0, 2048) } }
      : {}),
  }
}

export function createDiscordProvider(deps: NotifyDeps): NotificationProvider {
  async function webhookUrl(): Promise<string> {
    return (await deps.readSetting('discordWebhookUrl')).trim()
  }

  async function readiness(): Promise<ProviderReadiness> {
    const url = await webhookUrl()
    if (!url) {
      return {
        configured: false,
        label: 'Discord belum dikonfigurasi',
        hint: 'Tempel URL webhook Discord di Pengaturan. Belum ada laporan yang bisa dikirim ke sana.',
      }
    }
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(url)) {
      return {
        configured: false,
        label: 'URL webhook Discord tidak dikenali',
        hint: 'URL harus dimulai dengan https://discord.com/api/webhooks/',
      }
    }
    return {
      // "Terkonfigurasi" — BUKAN "tersambung". Kita belum pernah mengirim apa
      // pun ke URL ini; yang kita tahu hanya bentuk URL-nya benar.
      configured: true,
      label: 'Discord terkonfigurasi',
      hint: null,
    }
  }

  return {
    channel: 'DISCORD',
    name: 'discord-webhook',

    async isConfigured() {
      return (await readiness()).configured
    },

    describe: readiness,

    async send(message) {
      const url = await webhookUrl()
      if (!url) {
        // Tidak retryable: tidak ada alamat tujuan, dan mencoba lagi tidak akan
        // menciptakannya.
        throw sendErrorFromResponse('Discord', 400, 'webhook belum diisi', null)
      }

      let res: Response
      try {
        res = await deps.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [embedFromMessage(message)] }),
          signal: deps.timeoutSignal(),
        })
      } catch (e) {
        throw sendErrorFromNetwork('Discord', e)
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw sendErrorFromResponse(
          'Discord',
          res.status,
          body,
          parseRetryAfter(res.headers.get('retry-after'), deps.now()),
        )
      }
    },
  }
}
