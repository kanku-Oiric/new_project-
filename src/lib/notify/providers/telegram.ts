import {
  parseRetryAfter,
  sendErrorFromNetwork,
  sendErrorFromResponse,
} from '../backoff'
import type { NotificationProvider, ProviderReadiness, ReportMessage } from '../types'
import type { NotifyDeps } from './deps'

/**
 * Telegram lewat Bot API.
 *
 * Butuh dua nilai: token bot (rahasia) dan chat id tujuan. Token HANYA dipakai
 * di URL request dan tidak pernah ikut ke pesan error yang ditampilkan ke layar
 * — URL-nya memuat token, jadi pesan gagal yang menyalin URL akan membocorkannya
 * ke siapa pun yang melihat layar kasir.
 */

const TELEGRAM_LIMIT = 4096

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function htmlFromMessage(message: ReportMessage): string {
  const parts: string[] = [
    `<b>${escapeHtml(message.title)}</b>`,
    escapeHtml(message.periodLabel),
  ]

  for (const section of message.sections) {
    parts.push('')
    parts.push(`<b>${escapeHtml(section.label)}</b>`)
    for (const r of section.rows) {
      const line = `${escapeHtml(r.label)}: ${escapeHtml(r.value)}`
      parts.push(r.emphasis ? `<b>${line}</b>` : line)
    }
  }

  if (message.aiInsight) {
    parts.push('')
    parts.push('<b>Analisis</b>')
    parts.push(escapeHtml(message.aiInsight))
  }

  if (message.footnotes?.length) {
    parts.push('')
    for (const note of message.footnotes) parts.push(`<i>${escapeHtml(note)}</i>`)
  }

  return parts.join('\n').slice(0, TELEGRAM_LIMIT)
}

export function createTelegramProvider(deps: NotifyDeps): NotificationProvider {
  async function credentials(): Promise<{ token: string; chatId: string }> {
    const [token, chatId] = await Promise.all([
      deps.readSetting('telegramBotToken'),
      deps.readSetting('telegramChatId'),
    ])
    return { token: token.trim(), chatId: chatId.trim() }
  }

  async function readiness(): Promise<ProviderReadiness> {
    const { token, chatId } = await credentials()
    if (!token && !chatId) {
      return {
        configured: false,
        label: 'Telegram belum dikonfigurasi',
        hint: 'Isi token bot dan chat id di Pengaturan.',
      }
    }
    if (!token) {
      return {
        configured: false,
        label: 'Telegram belum dikonfigurasi',
        hint: 'Chat id sudah ada, token bot belum diisi.',
      }
    }
    if (!chatId) {
      return {
        configured: false,
        label: 'Telegram belum dikonfigurasi',
        hint: 'Token bot sudah ada, chat id tujuan belum diisi.',
      }
    }
    return { configured: true, label: 'Telegram terkonfigurasi', hint: null }
  }

  return {
    channel: 'TELEGRAM',
    name: 'telegram-bot',

    async isConfigured() {
      return (await readiness()).configured
    },

    describe: readiness,

    async send(message) {
      const { token, chatId } = await credentials()
      if (!token || !chatId) {
        throw sendErrorFromResponse('Telegram', 400, 'token atau chat id belum diisi', null)
      }

      let res: Response
      try {
        res = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: htmlFromMessage(message),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: deps.timeoutSignal(),
        })
      } catch (e) {
        throw sendErrorFromNetwork('Telegram', e)
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw sendErrorFromResponse(
          'Telegram',
          res.status,
          // Body Telegram tidak memuat token, tapi disaring juga untuk berjaga:
          // pesan ini berakhir di kolom lastError yang tampil di layar.
          body.replaceAll(token, '<token>'),
          parseRetryAfter(res.headers.get('retry-after'), deps.now()),
        )
      }
    },
  }
}
