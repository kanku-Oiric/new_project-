'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { outcomeMessage, postJson } from '@/lib/api-client'
import type { ReportChannel, ReportKind } from '@/lib/enums'

export interface DeliveryRow {
  id: string
  kind: string
  periodKey: string
  channel: string
  trigger: string
  status: string
  attempts: number
  lastError: string | null
  createdAt: Date
  sentAt: Date | null
}

interface ChannelInfo {
  channel: ReportChannel
  configured: boolean
  label: string
  hint: string | null
}

interface SendResult {
  results: { channel: string; status: string; error: string | null }[]
}

interface InsightResponse {
  status: string
  message: string
  text: string | null
  model: string | null
  createdAt: string | null
}

export interface CachedInsightRow {
  text: string
  model: string
  createdAt: string
}

const KIND_OPTIONS: { value: ReportKind; label: string }[] = [
  { value: 'DAILY', label: 'Harian' },
  { value: 'WEEKLY', label: 'Mingguan' },
  { value: 'MONTHLY', label: 'Bulanan' },
]

/** Tipe input HTML yang cocok untuk tiap jenis periode. */
const INPUT_TYPE: Record<ReportKind, string> = {
  DAILY: 'date',
  WEEKLY: 'week',
  MONTHLY: 'month',
}

export function ReportControls({
  kind,
  periodKey,
  periodLabel,
  periodComplete,
  channels,
  deliveries,
  aiEnabled,
  aiCached,
}: {
  kind: ReportKind
  periodKey: string
  periodLabel: string
  periodComplete: boolean
  channels: ChannelInfo[]
  deliveries: DeliveryRow[]
  aiEnabled: boolean
  aiCached: CachedInsightRow | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [ai, setAi] = useState<InsightResponse | null>(null)

  const siap = channels.filter((c) => c.configured)

  function go(nextKind: ReportKind, nextPeriod: string) {
    router.push(`/laporan?kind=${nextKind}&period=${encodeURIComponent(nextPeriod)}`)
  }

  return (
    <>
      <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <div className="flex flex-wrap gap-2">
          {KIND_OPTIONS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => go(k.value, '')}
              className={`h-11 flex-1 rounded-xl border px-3 text-sm ${
                k.value === kind
                  ? 'border-kasir-accent bg-kasir-accent text-white'
                  : 'border-kasir-border text-kasir-text'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Periode</span>
          {/* `key` memaksa input dibuat ulang saat jenis atau periodenya
              berubah, supaya nilai lama berformat berbeda (mis. "2026-09-18"
              pada input bulan) tidak tertinggal di layar. */}
          <input
            key={`${kind}-${periodKey}`}
            type={INPUT_TYPE[kind]}
            defaultValue={periodKey}
            onChange={(e) => {
              if (e.target.value) go(kind, e.target.value)
            }}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
          />
        </label>

        {!periodComplete && (
          <p className="mt-2 text-xs text-kasir-warning">
            Periode ini belum berakhir, jadi angkanya belum final. Laporan otomatis baru dikirim
            setelah periodenya selesai — tombol di bawah tetap bisa mengirimnya sekarang.
          </p>
        )}

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

        <div className="mt-3">
          <button
            type="button"
            disabled={busy || siap.length === 0}
            onClick={async () => {
              setBusy(true)
              setError(null)
              setNotice(null)

              const outcome = await postJson<SendResult>('/api/reports/send', {
                kind,
                periodKey,
              })
              setBusy(false)

              if (outcome.kind !== 'ok') {
                setError(outcomeMessage(outcome, false))
                return
              }

              const hasil = outcome.data.results
              const gagal = hasil.filter((r) => r.status !== 'SENT')
              if (gagal.length === 0) {
                setNotice(`Terkirim ke ${hasil.map((r) => r.channel).join(', ')}.`)
              } else {
                // Tidak dibulatkan menjadi "berhasil": kalau satu saluran gagal,
                // pemilik harus tahu saluran mana dan kenapa.
                setError(
                  gagal.map((r) => `${r.channel}: ${r.error ?? 'gagal tanpa keterangan'}`).join(' · '),
                )
              }
              router.refresh()
            }}
            className="h-12 w-full rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Mengirim…' : `Kirim laporan ${periodLabel} sekarang`}
          </button>

          {siap.length === 0 && (
            <p className="mt-1 text-xs text-kasir-muted">
              Belum ada saluran notifikasi yang dikonfigurasi. Isi webhook Discord atau token
              Telegram di Pengaturan.
            </p>
          )}
        </div>

        <ul className="mt-3 space-y-1">
          {channels.map((c) => (
            <li key={c.channel} className="text-xs text-kasir-muted">
              <span className={c.configured ? 'text-kasir-accent-strong' : ''}>{c.label}</span>
              {c.hint ? ` — ${c.hint}` : ''}
            </li>
          ))}
        </ul>
      </section>

      {kind !== 'DAILY' && (
        <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <h2 className="text-base font-semibold text-kasir-text">Analisis AI</h2>

          {!aiEnabled ? (
            <p className="mt-2 text-sm text-kasir-muted">
              Dimatikan. Isi <code>AI_ENABLED=true</code> dan <code>GEMINI_API_KEY</code> di berkas
              .env kalau mau memakainya. Selama mati, seluruh laporan tetap dihitung dan dikirim
              seperti biasa — tidak ada bagian yang bergantung padanya.
            </p>
          ) : (
            <>
              <p className="mt-2 text-xs text-kasir-muted">
                Maksimal satu panggilan per hari, hanya untuk laporan mingguan dan bulanan. Yang
                dikirim ke Google hanya angka agregat penjualan periode ini — tanpa nama kasir,
                tanpa nomor transaksi, tanpa isi pengaturan.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={async () => {
                    setAiBusy(true)
                    setAi(null)
                    const outcome = await postJson<InsightResponse>('/api/ai/insight', {
                      kind,
                      periodKey,
                    })
                    setAiBusy(false)
                    if (outcome.kind !== 'ok') {
                      setAi({
                        status: 'FAILED',
                        message: outcomeMessage(outcome, false),
                        text: null,
                        model: null,
                        createdAt: null,
                      })
                      return
                    }
                    setAi(outcome.data)
                  }}
                  className="h-11 rounded-xl border border-kasir-border px-4 text-sm text-kasir-text disabled:opacity-40"
                >
                  {aiBusy ? 'Meminta analisis…' : aiCached ? 'Tampilkan analisis' : 'Minta analisis'}
                </button>

                {aiCached && (
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={async () => {
                      setAiBusy(true)
                      setAi(null)
                      const outcome = await postJson<InsightResponse>('/api/ai/insight', {
                        kind,
                        periodKey,
                        refresh: true,
                      })
                      setAiBusy(false)
                      if (outcome.kind !== 'ok') {
                        setAi({
                          status: 'FAILED',
                          message: outcomeMessage(outcome, false),
                          text: null,
                          model: null,
                          createdAt: null,
                        })
                        return
                      }
                      setAi(outcome.data)
                      router.refresh()
                    }}
                    className="h-11 rounded-xl border border-kasir-border px-4 text-sm text-kasir-muted disabled:opacity-40"
                  >
                    Analisis ulang (pakai kuota)
                  </button>
                )}
              </div>
            </>
          )}

          {/* Hasil tersimpan ditampilkan walau tombol belum ditekan: ia sudah
              dibayar, dan menyembunyikannya di balik satu klik tidak ada gunanya. */}
          {ai === null && aiCached && (
            <div className="mt-3">
              <p className="text-xs text-kasir-muted">
                Tersimpan {new Date(aiCached.createdAt).toLocaleString('id-ID')} · {aiCached.model}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-kasir-text">{aiCached.text}</p>
            </div>
          )}

          {ai && (
            <div className="mt-3">
              <p
                className={`text-sm ${
                  ai.status === 'FRESH' || ai.status === 'CACHED'
                    ? 'text-kasir-muted'
                    : 'text-kasir-warning'
                }`}
              >
                {ai.message}
              </p>
              {ai.text && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-kasir-text">{ai.text}</p>
              )}
            </div>
          )}

          <p className="mt-3 text-xs text-kasir-muted">
            Teks analisis tidak pernah mengubah harga, stok, kas, atau transaksi. Ia tersimpan di
            tabelnya sendiri dan hanya dibaca manusia.
          </p>
        </section>
      )}

      {deliveries.length > 0 && (
        <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <h2 className="text-base font-semibold text-kasir-text">Riwayat pengiriman</h2>
          <ul className="mt-2 divide-y divide-kasir-border">
            {deliveries.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-kasir-text">
                    {d.kind} {d.periodKey} · {d.channel}
                  </p>
                  <p className="text-xs text-kasir-muted">
                    {d.trigger === 'AUTO' ? 'otomatis' : 'manual'} ·{' '}
                    {d.status === 'SENT'
                      ? `terkirim ${d.sentAt ? new Date(d.sentAt).toLocaleString('id-ID') : ''}`
                      : d.status === 'PENDING'
                        ? 'menunggu'
                        : `gagal setelah ${d.attempts} percobaan`}
                  </p>
                  {d.lastError && (
                    <p className="mt-0.5 break-words text-xs text-kasir-danger">{d.lastError}</p>
                  )}
                </div>

                {d.status !== 'SENT' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setError(null)
                      setNotice(null)
                      const outcome = await postJson<{ status: string; error: string | null }>(
                        `/api/reports/deliveries/${d.id}/retry`,
                        {},
                      )
                      setBusy(false)
                      if (outcome.kind !== 'ok') {
                        setError(outcomeMessage(outcome, false))
                        return
                      }
                      if (outcome.data.status === 'SENT') setNotice('Berhasil dikirim ulang.')
                      else setError(outcome.data.error ?? 'Masih gagal.')
                      router.refresh()
                    }}
                    className="h-10 shrink-0 rounded-lg border border-kasir-border px-3 text-sm text-kasir-text disabled:opacity-40"
                  >
                    Coba lagi
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
