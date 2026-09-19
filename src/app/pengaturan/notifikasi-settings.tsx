'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { outcomeMessage, patchJson, postJson } from '@/lib/api-client'
import { OwnerPinDialog } from '@/components/ui/owner-pin-dialog'
import type { ReportChannel } from '@/lib/enums'

export interface ChannelStatus {
  channel: ReportChannel
  configured: boolean
  label: string
  hint: string | null
  lastSentAt: string | null
}

/**
 * Pengaturan pengiriman laporan.
 *
 * Status yang ditampilkan hanya empat, dan semuanya keadaan nyata:
 * belum dikonfigurasi / terkonfigurasi (belum diuji) / terakhir berhasil <waktu>
 * / gagal. Tidak ada keadaan bernama "tersambung", karena kredensial yang
 * terisi tidak membuktikan apa pun tentang webhook yang sudah dihapus pemiliknya
 * dari server Discord (docs/architecture.md §11).
 */
export function NotifikasiSettings({
  channels,
  discordMasked,
  telegramTokenMasked,
  telegramChatId,
}: {
  channels: ChannelStatus[]
  discordMasked: string
  telegramTokenMasked: string
  telegramChatId: string
}) {
  const router = useRouter()
  const [discord, setDiscord] = useState('')
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState(telegramChatId)
  const [pinFor, setPinFor] = useState<null | 'discord' | 'telegram'>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function simpan(ownerPin: string, values: Record<string, string>) {
    setBusy(true)
    setError(null)
    const outcome = await patchJson('/api/settings', { ownerPin, values })
    setBusy(false)
    if (outcome.kind !== 'ok') {
      setError(outcomeMessage(outcome, true))
      return false
    }
    setPinFor(null)
    setNotice('Tersimpan. Kirim pesan uji untuk memastikan benar-benar sampai.')
    router.refresh()
    return true
  }

  async function kirimUji(channel: ReportChannel) {
    setBusy(true)
    setError(null)
    setNotice(null)
    const outcome = await postJson<{ ok: boolean; error: string | null }>(
      '/api/notifications/test',
      { channel },
    )
    setBusy(false)

    if (outcome.kind !== 'ok') {
      setError(outcomeMessage(outcome, false))
      return
    }
    if (outcome.data.ok) {
      setNotice(`Pesan uji berhasil dikirim ke ${channel}. Periksa aplikasinya.`)
      router.refresh()
      return
    }
    setError(`${channel}: ${outcome.data.error ?? 'gagal tanpa keterangan'}`)
  }

  return (
    <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <h2 className="text-base font-semibold text-kasir-text">Pengiriman laporan</h2>
      <p className="mt-1 text-sm text-kasir-muted">
        Laporan dikirim otomatis setelah periodenya berakhir, dan saat server dinyalakan kembali
        untuk periode yang terlewat. Kalau internet mati, transaksi tetap berjalan seperti biasa.
      </p>

      <ul className="mt-3 space-y-2">
        {channels.map((c) => (
          <li key={c.channel} className="rounded-lg border border-kasir-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-kasir-text">{c.label}</p>
                {c.hint && <p className="mt-0.5 text-xs text-kasir-muted">{c.hint}</p>}
                <p className="mt-0.5 text-xs text-kasir-muted">
                  {c.lastSentAt
                    ? `Terakhir berhasil ${new Date(c.lastSentAt).toLocaleString('id-ID')}`
                    : c.configured
                      ? 'Terkonfigurasi (belum pernah berhasil mengirim)'
                      : 'Belum pernah mengirim'}
                </p>
              </div>
              <button
                type="button"
                disabled={busy || !c.configured}
                onClick={() => void kirimUji(c.channel)}
                className="h-10 shrink-0 rounded-lg border border-kasir-border px-3 text-sm text-kasir-text disabled:opacity-40"
              >
                Kirim uji
              </button>
            </div>
          </li>
        ))}
      </ul>

      {notice && (
        <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-kasir-accent-strong">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <label className="mt-4 block">
        <span className="mb-1 block text-xs text-kasir-muted">
          Webhook Discord {discordMasked && `(tersimpan: ${discordMasked})`}
        </span>
        <input
          type="text"
          value={discord}
          placeholder="https://discord.com/api/webhooks/…"
          onChange={(e) => setDiscord(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-sm"
        />
      </label>
      <button
        type="button"
        disabled={busy || discord.trim() === ''}
        onClick={() => {
          setError(null)
          setPinFor('discord')
        }}
        className="mt-2 h-11 w-full rounded-xl border border-kasir-border text-sm text-kasir-text disabled:opacity-40"
      >
        Simpan webhook Discord
      </button>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs text-kasir-muted">
          Token bot Telegram {telegramTokenMasked && `(tersimpan: ${telegramTokenMasked})`}
        </span>
        <input
          type="password"
          value={token}
          autoComplete="off"
          placeholder="123456:ABC…"
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-sm"
        />
      </label>
      <label className="mt-2 block">
        <span className="mb-1 block text-xs text-kasir-muted">Chat id Telegram</span>
        <input
          type="text"
          value={chatId}
          placeholder="-1001234567890"
          onChange={(e) => setChatId(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-sm"
        />
      </label>
      <button
        type="button"
        disabled={busy || (token.trim() === '' && chatId.trim() === telegramChatId)}
        onClick={() => {
          setError(null)
          setPinFor('telegram')
        }}
        className="mt-2 h-11 w-full rounded-xl border border-kasir-border text-sm text-kasir-text disabled:opacity-40"
      >
        Simpan Telegram
      </button>

      <p className="mt-4 text-xs text-kasir-muted">
        WhatsApp tidak tersedia. Jalur tidak resmi berisiko membuat nomor toko diblokir permanen,
        dan itu bukan harga yang pantas untuk sebuah laporan harian.
      </p>

      {pinFor && (
        <OwnerPinDialog
          title={pinFor === 'discord' ? 'Simpan webhook Discord' : 'Simpan pengaturan Telegram'}
          description="Nilai lama akan diganti."
          confirmLabel="Simpan"
          reasonLabel={null}
          tone="accent"
          busy={busy}
          error={error}
          onCancel={() => setPinFor(null)}
          onConfirm={async (ownerPin) => {
            const values: Record<string, string> =
              pinFor === 'discord'
                ? { discordWebhookUrl: discord.trim() }
                : {
                    // Token hanya ikut dikirim kalau memang diketik ulang —
                    // mengirim string kosong akan MENGHAPUS token tersimpan
                    // padahal pemilik cuma mengubah chat id.
                    ...(token.trim() ? { telegramBotToken: token.trim() } : {}),
                    telegramChatId: chatId.trim(),
                  }

            const ok = await simpan(ownerPin, values)
            if (ok) {
              setDiscord('')
              setToken('')
            }
          }}
        />
      )}
    </section>
  )
}
