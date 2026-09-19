import { describe, expect, it } from 'vitest'
import { NotConfiguredError } from '../errors'
import type { SettingKey, SettingValue } from '../settings'
import {
  MAX_SEND_ATTEMPTS,
  backoffDelayMs,
  parseRetryAfter,
  sendErrorFromNetwork,
  sendErrorFromResponse,
  shouldRetry,
} from './backoff'
import { drainQueue, enqueue } from './queue'
import { createDiscordProvider, embedFromMessage } from './providers/discord'
import type { NotifyDeps } from './providers/deps'
import { createTelegramProvider, escapeHtml, htmlFromMessage } from './providers/telegram'
import { WHATSAPP_NOT_CONFIGURED, sendWhatsApp, whatsappReadiness } from './providers/whatsapp'
import { sendWithRetry } from './send'
import { SendError, type NotificationProvider, type ReportMessage } from './types'

const MESSAGE: ReportMessage = {
  title: 'Laporan Harian · Toko Saya',
  periodLabel: 'Jumat, 18 September 2026',
  sections: [
    {
      label: 'Penjualan',
      rows: [
        { label: 'Penjualan Kotor', value: 'Rp 54.500' },
        { label: 'Penjualan Bersih', value: 'Rp 48.500', emphasis: true },
      ],
    },
  ],
  footnotes: ['Refund dihitung pada tanggal refund terjadi.'],
}

function fakeDeps(opts: {
  settings?: Partial<Record<SettingKey, unknown>>
  fetch?: typeof fetch
}): NotifyDeps {
  const values: Partial<Record<SettingKey, unknown>> = {
    discordWebhookUrl: '',
    telegramBotToken: '',
    telegramChatId: '',
    ...opts.settings,
  }
  return {
    readSetting: async <K extends SettingKey>(key: K) => values[key] as SettingValue<K>,
    fetch: opts.fetch ?? (async () => new Response(null, { status: 204 })),
    timeoutSignal: () => AbortSignal.timeout(1_000),
    now: () => new Date('2026-09-18T12:00:00Z'),
  }
}

describe('backoffDelayMs', () => {
  it('1s → 2s → 4s → 8s → 16s tanpa jitter', () => {
    const zero = { random: () => 0 }
    expect(backoffDelayMs(1, zero)).toBe(1_000)
    expect(backoffDelayMs(2, zero)).toBe(2_000)
    expect(backoffDelayMs(3, zero)).toBe(4_000)
    expect(backoffDelayMs(4, zero)).toBe(8_000)
    expect(backoffDelayMs(5, zero)).toBe(16_000)
  })

  it('jitter menambah maksimal 25%, supaya kiriman yang gagal bersamaan tidak kembali serentak', () => {
    expect(backoffDelayMs(1, { random: () => 1 })).toBe(1_250)
    expect(backoffDelayMs(3, { random: () => 1 })).toBe(5_000)
  })

  it('Retry-After dari server selalu menang atas hitungan sendiri', () => {
    expect(backoffDelayMs(1, { retryAfterMs: 7_000, random: () => 0 })).toBe(7_000)
  })

  it('tidak pernah tidur lebih dari satu menit', () => {
    expect(backoffDelayMs(1, { retryAfterMs: 3_600_000 })).toBe(60_000)
    expect(backoffDelayMs(20, { random: () => 0 })).toBe(60_000)
  })

  it('menolak attempt yang tidak masuk akal', () => {
    expect(() => backoffDelayMs(0)).toThrow(RangeError)
  })
})

describe('parseRetryAfter', () => {
  const now = new Date('2026-09-18T12:00:00Z')

  it('membaca detik', () => {
    expect(parseRetryAfter('3', now)).toBe(3_000)
    expect(parseRetryAfter('0.5', now)).toBe(500)
  })

  it('membaca tanggal HTTP', () => {
    expect(parseRetryAfter('Fri, 18 Sep 2026 12:00:30 GMT', now)).toBe(30_000)
  })

  it('tanggal yang sudah lewat berarti boleh sekarang', () => {
    expect(parseRetryAfter('Fri, 18 Sep 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('header kosong atau ngawur menghasilkan null', () => {
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter('entah', now)).toBeNull()
  })
})

describe('klasifikasi kegagalan', () => {
  it('429 dan 5xx layak dicoba lagi', () => {
    expect(sendErrorFromResponse('Discord', 429, '', 1_000).retryable).toBe(true)
    expect(sendErrorFromResponse('Discord', 500, '', null).retryable).toBe(true)
    expect(sendErrorFromResponse('Discord', 503, '', null).retryable).toBe(true)
  })

  it('4xx lain TIDAK — token dicabut tidak akan benar setelah lima percobaan', () => {
    expect(sendErrorFromResponse('Telegram', 401, 'Unauthorized', null).retryable).toBe(false)
    expect(sendErrorFromResponse('Discord', 404, 'Unknown Webhook', null).retryable).toBe(false)
  })

  it('gagal jaringan layak dicoba lagi — internet toko sering putus sebentar', () => {
    expect(sendErrorFromNetwork('Discord', new Error('ECONNRESET')).retryable).toBe(true)
  })

  it('shouldRetry berhenti di percobaan terakhir', () => {
    const e = sendErrorFromResponse('Discord', 500, '', null)
    expect(shouldRetry(e, 4, 5)).toBe(true)
    expect(shouldRetry(e, 5, 5)).toBe(false)
  })
})

describe('sendWithRetry', () => {
  function providerThatFails(
    times: number,
    error: SendError,
  ): { provider: NotificationProvider; calls: () => number } {
    let calls = 0
    const provider: NotificationProvider = {
      channel: 'DISCORD',
      name: 'uji',
      isConfigured: async () => true,
      describe: async () => ({ configured: true, label: 'uji', hint: null }),
      send: async () => {
        calls++
        if (calls <= times) throw error
      },
    }
    return { provider, calls: () => calls }
  }

  const noSleep = { sleep: async () => undefined, random: () => 0 }

  it('berhasil di percobaan pertama', async () => {
    const { provider, calls } = providerThatFails(0, new SendError('x', { retryable: true }))
    const outcome = await sendWithRetry(provider, MESSAGE, noSleep)

    expect(outcome.ok).toBe(true)
    expect(outcome.attempts).toBe(1)
    expect(calls()).toBe(1)
  })

  it('mencoba lagi lalu berhasil', async () => {
    const { provider, calls } = providerThatFails(2, new SendError('sibuk', { retryable: true }))
    const outcome = await sendWithRetry(provider, MESSAGE, noSleep)

    expect(outcome.ok).toBe(true)
    expect(outcome.attempts).toBe(3)
    expect(calls()).toBe(3)
  })

  it('menyerah setelah lima percobaan, TANPA melempar', async () => {
    const { provider, calls } = providerThatFails(99, new SendError('mati', { retryable: true }))
    const outcome = await sendWithRetry(provider, MESSAGE, noSleep)

    // Kegagalan kirim laporan tidak boleh merambat ke pemanggilnya — pemanggil
    // bisa jadi proses startup, dan toko harus tetap bisa jualan.
    expect(outcome.ok).toBe(false)
    expect(outcome.attempts).toBe(MAX_SEND_ATTEMPTS)
    expect(calls()).toBe(MAX_SEND_ATTEMPTS)
    expect(outcome.error).toContain('mati')
  })

  it('kegagalan permanen berhenti setelah SATU percobaan', async () => {
    const { provider, calls } = providerThatFails(
      99,
      new SendError('webhook dihapus', { retryable: false, status: 404 }),
    )
    const outcome = await sendWithRetry(provider, MESSAGE, noSleep)

    expect(outcome.ok).toBe(false)
    expect(outcome.permanent).toBe(true)
    expect(calls()).toBe(1)
  })

  it('error tak terduga dari provider diperlakukan permanen, bukan diulang lima kali', async () => {
    const provider: NotificationProvider = {
      channel: 'DISCORD',
      name: 'uji',
      isConfigured: async () => true,
      describe: async () => ({ configured: true, label: 'uji', hint: null }),
      send: async () => {
        throw new TypeError('bug di provider')
      },
    }
    const outcome = await sendWithRetry(provider, MESSAGE, noSleep)

    expect(outcome.ok).toBe(false)
    expect(outcome.permanent).toBe(true)
    expect(outcome.attempts).toBe(1)
  })
})

describe('DiscordProvider', () => {
  it('belum siap kalau webhook kosong, dan tidak mengklaim tersambung saat terisi', async () => {
    const kosong = createDiscordProvider(fakeDeps({}))
    expect(await kosong.isConfigured()).toBe(false)
    expect((await kosong.describe()).label).toMatch(/belum dikonfigurasi/i)

    const terisi = createDiscordProvider(
      fakeDeps({ settings: { discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' } }),
    )
    const readiness = await terisi.describe()
    expect(readiness.configured).toBe(true)
    // "Terkonfigurasi", BUKAN "tersambung": belum ada satu pun kiriman yang
    // sukses ke URL itu.
    expect(readiness.label).toBe('Discord terkonfigurasi')
    expect(readiness.label).not.toMatch(/tersambung|terhubung/i)
  })

  it('menolak URL yang jelas bukan webhook Discord', async () => {
    const p = createDiscordProvider(
      fakeDeps({ settings: { discordWebhookUrl: 'https://contoh.com/hook' } }),
    )
    expect(await p.isConfigured()).toBe(false)
  })

  it('mengirim embed berisi seluruh section', async () => {
    let captured: { url: string; body: unknown } | null = null
    const p = createDiscordProvider(
      fakeDeps({
        settings: { discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        fetch: async (input, init) => {
          captured = {
            url: String(input),
            body: JSON.parse(String(init?.body)) as unknown,
          }
          return new Response(null, { status: 204 })
        },
      }),
    )

    await p.send(MESSAGE)

    const sent = captured as unknown as { url: string; body: { embeds: Record<string, unknown>[] } }
    expect(sent.url).toBe('https://discord.com/api/webhooks/1/abc')
    const embed = sent.body.embeds[0] as { title: string; fields: { name: string }[] }
    expect(embed.title).toBe(MESSAGE.title)
    expect(embed.fields[0]?.name).toBe('Penjualan')
  })

  it('HTTP 500 dari Discord dilaporkan sebagai kegagalan yang layak diulang', async () => {
    const p = createDiscordProvider(
      fakeDeps({
        settings: { discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        fetch: async () => new Response('server sibuk', { status: 500 }),
      }),
    )

    await expect(p.send(MESSAGE)).rejects.toMatchObject({ retryable: true, status: 500 })
  })

  it('embed memuat baris penting dalam huruf tebal', () => {
    const embed = embedFromMessage(MESSAGE) as { fields: { value: string }[] }
    expect(embed.fields[0]?.value).toContain('**Penjualan Bersih: Rp 48.500**')
  })
})

describe('TelegramProvider', () => {
  it('butuh token DAN chat id, dan menyebut mana yang kurang', async () => {
    const tanpaChat = createTelegramProvider(
      fakeDeps({ settings: { telegramBotToken: '123:abc' } }),
    )
    expect(await tanpaChat.isConfigured()).toBe(false)
    expect((await tanpaChat.describe()).hint).toMatch(/chat id/i)

    const lengkap = createTelegramProvider(
      fakeDeps({ settings: { telegramBotToken: '123:abc', telegramChatId: '-100' } }),
    )
    expect(await lengkap.isConfigured()).toBe(true)
  })

  it('meng-escape HTML supaya nama produk bertanda < tidak merusak pesan', () => {
    expect(escapeHtml('Teh <botol> & gula')).toBe('Teh &lt;botol&gt; &amp; gula')

    const html = htmlFromMessage({
      ...MESSAGE,
      sections: [
        { label: 'Penjualan', rows: [{ label: 'Item <A>', value: 'Rp 1.000' }] },
      ],
    })
    expect(html).toContain('Item &lt;A&gt;: Rp 1.000')
  })

  it('token tidak pernah ikut ke pesan error yang tampil di layar', async () => {
    const token = '123456:RAHASIA-SEKALI'
    const p = createTelegramProvider(
      fakeDeps({
        settings: { telegramBotToken: token, telegramChatId: '-100' },
        fetch: async () => new Response(`gagal untuk bot${token}`, { status: 400 }),
      }),
    )

    await expect(p.send(MESSAGE)).rejects.toThrow(/<token>/)
    await expect(p.send(MESSAGE)).rejects.not.toThrow(new RegExp(token))
  })
})

describe('WhatsApp — stub yang jujur', () => {
  it('melempar NotConfiguredError dengan alasannya, bukan diam-diam gagal', () => {
    expect(() => sendWhatsApp()).toThrow(NotConfiguredError)
    expect(() => sendWhatsApp()).toThrow(/WhatsApp Business API resmi/i)
  })

  it('tidak pernah mengaku tersedia', () => {
    const r = whatsappReadiness()
    expect(r.configured).toBe(false)
    expect(r.hint).toBe(WHATSAPP_NOT_CONFIGURED)
    // Alasannya ditulis apa adanya: library tidak resmi berisiko nomor toko
    // diblokir, dan itu bukan harga yang pantas untuk sebuah laporan harian.
    expect(r.hint).toMatch(/diblokir/i)
  })
})

describe('antrean pengiriman', () => {
  it('menjalankan task berurutan, satu per satu', async () => {
    const urutan: string[] = []
    const tugas = (nama: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms))
      urutan.push(nama)
      return nama
    }

    const a = enqueue(tugas('a', 30))
    const b = enqueue(tugas('b', 1))
    const c = enqueue(tugas('c', 1))

    await Promise.all([a, b, c])
    expect(urutan).toEqual(['a', 'b', 'c'])
  })

  it('satu task gagal tidak membatalkan task setelahnya', async () => {
    const hasil: string[] = []
    const gagal = enqueue(async () => {
      throw new Error('gagal')
    })
    const lanjut = enqueue(async () => {
      hasil.push('tetap jalan')
    })

    await expect(gagal).rejects.toThrow('gagal')
    await lanjut
    await drainQueue()
    expect(hasil).toEqual(['tetap jalan'])
  })
})
