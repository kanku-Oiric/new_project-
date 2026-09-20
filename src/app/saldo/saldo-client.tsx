'use client'

import { useCallback, useEffect, useState } from 'react'
import { getJson, outcomeMessage, postJson } from '@/lib/api-client'
import { formatRupiah, parseRupiah } from '@/lib/money'
import { useIdempotencyKey } from '@/lib/use-idempotency-key'

export interface ProviderRow {
  id: string
  nama: string
  jenis: string
  saldo: number
  urutan: number
  aktif: boolean
}

interface MovementRow {
  id: string
  amountChange: number
  reason: string
  balanceBefore: number
  balanceAfter: number
  paidFrom: string | null
  note: string | null
  businessDate: string
  createdAt: string
}

const ALASAN_LABEL: Record<string, string> = {
  INITIAL: 'Saldo awal',
  TOPUP: 'Top-up',
  SERVICE: 'Transaksi jasa',
  SERVICE_FAILED: 'Jasa gagal',
  ADJUSTMENT: 'Penyesuaian',
}

export function SaldoClient({ initialProviders }: { initialProviders: ProviderRow[] }) {
  const [providers, setProviders] = useState(initialProviders)
  const [topupFor, setTopupFor] = useState<ProviderRow | null>(null)
  const [adjustFor, setAdjustFor] = useState<ProviderRow | null>(null)
  const [historyFor, setHistoryFor] = useState<ProviderRow | null>(null)
  const [adding, setAdding] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const outcome = await getJson<{ providers: ProviderRow[] }>('/api/providers?includeInactive=1')
    if (outcome.kind === 'ok') setProviders(outcome.data.providers)
  }, [])

  const total = providers.filter((p) => p.aktif).reduce((s, p) => s + p.saldo, 0)

  return (
    <>
      {banner && (
        <p role="alert" className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-kasir-text">
          {banner}
        </p>
      )}

      <div className="mb-3 flex items-baseline justify-between rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <span className="text-sm text-kasir-muted">Total saldo semua provider</span>
        <span className="text-xl font-semibold text-kasir-text">{formatRupiah(total)}</span>
      </div>

      {providers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-kasir-border p-6 text-center text-sm text-kasir-muted">
          Belum ada provider. Tambahkan satu supaya jasa pembayaran bisa dijual di layar kasir.
        </p>
      ) : (
        <ul className="divide-y divide-kasir-border rounded-xl border border-kasir-border bg-kasir-surface">
          {providers.map((p) => (
            <li key={p.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-kasir-text">
                    {p.nama}
                    <span className="ml-2 rounded bg-kasir-bg px-1.5 py-0.5 text-[11px] text-kasir-muted">
                      {p.jenis}
                    </span>
                    {!p.aktif && (
                      <span className="ml-2 text-[11px] text-kasir-muted">(nonaktif)</span>
                    )}
                  </p>
                  <p
                    className={`text-lg ${p.saldo < 0 ? 'font-medium text-kasir-danger' : 'text-kasir-text'}`}
                  >
                    {formatRupiah(p.saldo)}
                  </p>
                  {p.saldo < 0 && (
                    <p className="text-xs text-kasir-danger">
                      Saldo tercatat minus. Periksa saldo asli di aplikasinya, lalu sesuaikan.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => setTopupFor(p)}
                    className="h-9 rounded-lg bg-kasir-accent px-3 text-sm text-white"
                  >
                    Isi saldo
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdjustFor(p)}
                    className="h-9 rounded-lg border border-kasir-border px-3 text-sm"
                  >
                    Sesuaikan
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryFor(p)}
                    className="h-9 rounded-lg px-3 text-sm text-kasir-muted underline"
                  >
                    Riwayat
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setAdding(true)}
        className="mt-3 h-12 w-full rounded-xl border border-kasir-border text-base"
      >
        Tambah provider
      </button>

      {adding && (
        <ProviderDialog
          onCancel={() => setAdding(false)}
          onDone={async (nama) => {
            setAdding(false)
            setBanner(`Provider ${nama} ditambahkan.`)
            await refresh()
          }}
        />
      )}

      {topupFor && (
        <TopupDialog
          provider={topupFor}
          onCancel={() => setTopupFor(null)}
          onDone={async (pesan) => {
            setTopupFor(null)
            setBanner(pesan)
            await refresh()
          }}
        />
      )}

      {adjustFor && (
        <AdjustDialog
          provider={adjustFor}
          onCancel={() => setAdjustFor(null)}
          onDone={async (pesan) => {
            setAdjustFor(null)
            setBanner(pesan)
            await refresh()
          }}
        />
      )}

      {historyFor && (
        <HistoryDialog provider={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </>
  )
}

function Shell({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-t-2xl bg-kasir-surface p-4 sm:rounded-2xl">
        <h2 className="text-base font-semibold text-kasir-text">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function ProviderDialog({
  onCancel,
  onDone,
}: {
  onCancel: () => void
  onDone: (nama: string) => void
}) {
  const [nama, setNama] = useState('')
  const [jenis, setJenis] = useState<'EWALLET' | 'BANK' | 'PPOB'>('EWALLET')
  const [saldoText, setSaldoText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Shell title="Tambah provider">
      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">Nama (Shopee, GoPay, BRI, …)</span>
        <input
          type="text"
          autoFocus
          value={nama}
          maxLength={40}
          onChange={(e) => setNama(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-base"
        />
      </label>

      <fieldset className="mt-3">
        <legend className="mb-1 text-xs text-kasir-muted">Jenis</legend>
        <div className="flex gap-2">
          {(['EWALLET', 'BANK', 'PPOB'] as const).map((j) => (
            <button
              key={j}
              type="button"
              onClick={() => setJenis(j)}
              className={`h-11 flex-1 rounded-lg border text-sm ${
                j === jenis ? 'border-kasir-accent bg-kasir-accent/10' : 'border-kasir-border'
              }`}
            >
              {j === 'EWALLET' ? 'E-wallet' : j === 'BANK' ? 'Bank' : 'PPOB'}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">
          Saldo sekarang di aplikasinya (boleh 0)
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={saldoText}
          placeholder="0"
          onChange={(e) => setSaldoText(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-base"
        />
      </label>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-12 flex-1 rounded-xl border border-kasir-border text-base disabled:opacity-40"
        >
          Batal
        </button>
        <button
          type="button"
          disabled={busy || nama.trim() === ''}
          onClick={async () => {
            setBusy(true)
            setError(null)
            let saldoAwal = 0
            try {
              saldoAwal = parseRupiah(saldoText) ?? 0
            } catch {
              saldoAwal = 0
            }
            const outcome = await postJson('/api/providers', {
              nama: nama.trim(),
              jenis,
              saldoAwal,
            })
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            onDone(nama.trim())
          }}
          className="h-12 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Menyimpan…' : 'Simpan'}
        </button>
      </div>
    </Shell>
  )
}

function TopupDialog({
  provider,
  onCancel,
  onDone,
}: {
  provider: ProviderRow
  onCancel: () => void
  onDone: (pesan: string) => void
}) {
  const [amountText, setAmountText] = useState('')
  const [paidFrom, setPaidFrom] = useState<'CASH_DRAWER' | 'OTHER'>('CASH_DRAWER')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyFor = useIdempotencyKey()

  const amount = (() => {
    try {
      return parseRupiah(amountText) ?? 0
    } catch {
      return 0
    }
  })()

  return (
    <Shell title={`Isi saldo ${provider.nama}`}>
      <p className="mt-1 text-sm text-kasir-muted">
        Saldo sekarang {formatRupiah(provider.saldo)}
      </p>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">Nominal</span>
        <input
          type="text"
          inputMode="numeric"
          autoFocus
          value={amountText}
          onChange={(e) => {
            setAmountText(e.target.value)
            setError(null)
          }}
          className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
        />
      </label>

      <fieldset className="mt-3">
        <legend className="mb-1 text-xs text-kasir-muted">Uangnya dari mana</legend>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPaidFrom('CASH_DRAWER')}
            className={`h-11 flex-1 rounded-lg border text-sm ${
              paidFrom === 'CASH_DRAWER'
                ? 'border-kasir-accent bg-kasir-accent/10'
                : 'border-kasir-border'
            }`}
          >
            Laci kas
          </button>
          <button
            type="button"
            onClick={() => setPaidFrom('OTHER')}
            className={`h-11 flex-1 rounded-lg border text-sm ${
              paidFrom === 'OTHER' ? 'border-kasir-accent bg-kasir-accent/10' : 'border-kasir-border'
            }`}
          >
            Sumber lain
          </button>
        </div>
        <p className="mt-1 text-xs text-kasir-muted">
          {paidFrom === 'CASH_DRAWER'
            ? 'Uang diambil dari laci, jadi kas yang seharusnya ada berkurang sebesar ini. Bukan pengeluaran — laba tidak berubah.'
            : 'Transfer dari rekening lain. Saldo naik, laci tidak tersentuh.'}
        </p>
      </fieldset>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">Catatan (opsional)</span>
        <input
          type="text"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-base"
        />
      </label>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-12 flex-1 rounded-xl border border-kasir-border text-base disabled:opacity-40"
        >
          Batal
        </button>
        <button
          type="button"
          disabled={busy || amount < 1}
          onClick={async () => {
            setBusy(true)
            setError(null)

            const payload = {
              amount,
              paidFrom,
              ...(note.trim() ? { note: note.trim() } : {}),
            }
            const idempotencyKey = keyFor({ providerId: provider.id, ...payload })
            if (idempotencyKey === null) {
              setError(
                'Browser ini tidak bisa membuat kode pengaman, jadi top-up tidak bisa dicatat. ' +
                  'Gunakan browser lain (Chrome/Firefox versi baru).',
              )
              setBusy(false)
              return
            }

            const outcome = await postJson<{ balanceAfter: number }>(
              `/api/providers/${provider.id}/topup`,
              { ...payload, idempotencyKey },
            )
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            onDone(
              `Saldo ${provider.nama} sekarang ${formatRupiah(outcome.data.balanceAfter)}.`,
            )
          }}
          className="h-12 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Menyimpan…' : 'Isi saldo'}
        </button>
      </div>
    </Shell>
  )
}

function AdjustDialog({
  provider,
  onCancel,
  onDone,
}: {
  provider: ProviderRow
  onCancel: () => void
  onDone: (pesan: string) => void
}) {
  const [balanceText, setBalanceText] = useState('')
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyFor = useIdempotencyKey()

  const newBalance = (() => {
    try {
      return parseRupiah(balanceText) ?? 0
    } catch {
      return 0
    }
  })()
  const selisih = newBalance - provider.saldo

  return (
    <Shell title={`Sesuaikan saldo ${provider.nama}`}>
      <p className="mt-1 text-sm text-kasir-muted">
        Buka aplikasi {provider.nama}, baca saldo aslinya, lalu masukkan di sini. Selisihnya
        tercatat sebagai penyesuaian beserta alasannya.
      </p>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">
          Saldo asli di aplikasi (tercatat sekarang {formatRupiah(provider.saldo)})
        </span>
        <input
          type="text"
          inputMode="numeric"
          autoFocus
          value={balanceText}
          onChange={(e) => {
            setBalanceText(e.target.value)
            setError(null)
          }}
          className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
        />
      </label>

      {balanceText.trim() !== '' && selisih !== 0 && (
        <p className="mt-1 text-xs text-kasir-muted">
          Selisih {selisih > 0 ? '+' : ''}
          {formatRupiah(selisih)} akan dicatat.
        </p>
      )}

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">Alasan</span>
        <input
          type="text"
          value={reason}
          maxLength={300}
          placeholder="Hasil cek saldo di aplikasi"
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-base"
        />
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">PIN pemilik</span>
        <input
          type="password"
          inputMode="numeric"
          value={pin}
          maxLength={6}
          onChange={(e) => setPin(e.target.value)}
          className="w-full rounded-lg border border-kasir-border px-3 text-base tracking-widest"
        />
      </label>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-12 flex-1 rounded-xl border border-kasir-border text-base disabled:opacity-40"
        >
          Batal
        </button>
        <button
          type="button"
          disabled={busy || balanceText.trim() === '' || reason.trim().length < 3 || pin.length < 4}
          onClick={async () => {
            setBusy(true)
            setError(null)

            const payload = { newBalance, reason: reason.trim() }
            // PIN sengaja TIDAK ikut menentukan kunci: salah ketik PIN lalu
            // mengulang akan menghasilkan kunci baru dan penyesuaian kedua.
            const idempotencyKey = keyFor({ providerId: provider.id, ...payload })
            if (idempotencyKey === null) {
              setError('Browser ini tidak bisa membuat kode pengaman. Gunakan browser lain.')
              setBusy(false)
              return
            }

            const outcome = await postJson<{ balanceAfter: number }>(
              `/api/providers/${provider.id}/adjustment`,
              { ...payload, ownerPin: pin, idempotencyKey },
            )
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            onDone(`Saldo ${provider.nama} disesuaikan menjadi ${formatRupiah(outcome.data.balanceAfter)}.`)
          }}
          className="h-12 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Menyimpan…' : 'Sesuaikan'}
        </button>
      </div>
    </Shell>
  )
}

function HistoryDialog({
  provider,
  onClose,
}: {
  provider: ProviderRow
  onClose: () => void
}) {
  const [rows, setRows] = useState<MovementRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // useEffect, bukan pemanggilan di badan render. Fetch saat render akan
  // terpanggil dua kali di Strict Mode dan berpotensi berulang setiap render.
  useEffect(() => {
    let batal = false
    void getJson<{ movements: MovementRow[] }>(`/api/providers/${provider.id}/history`).then(
      (outcome) => {
        if (batal) return
        if (outcome.kind === 'ok') setRows(outcome.data.movements)
        else setError(outcomeMessage(outcome, false))
      },
    )
    return () => {
      batal = true
    }
  }, [provider.id])

  return (
    <Shell title={`Riwayat ${provider.nama}`}>
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      {rows === null ? (
        <p className="mt-3 text-sm text-kasir-muted">Memuat…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-kasir-muted">Belum ada pergerakan.</p>
      ) : (
        <ul className="mt-3 divide-y divide-kasir-border">
          {rows.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm text-kasir-text">
                  {ALASAN_LABEL[m.reason] ?? m.reason}
                  {m.paidFrom === 'CASH_DRAWER' && (
                    <span className="ml-1 text-xs text-kasir-muted">(dari laci)</span>
                  )}
                </p>
                {m.note && <p className="truncate text-xs text-kasir-muted">{m.note}</p>}
                <p className="text-xs text-kasir-muted">{m.businessDate}</p>
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={`text-sm ${m.amountChange < 0 ? 'text-kasir-danger' : 'text-kasir-accent-strong'}`}
                >
                  {m.amountChange > 0 ? '+' : ''}
                  {formatRupiah(m.amountChange, { bare: true })}
                </p>
                <p className="text-xs text-kasir-muted">
                  jadi {formatRupiah(m.balanceAfter, { bare: true })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onClose}
        className="mt-4 h-12 w-full rounded-xl border border-kasir-border text-base"
      >
        Tutup
      </button>
    </Shell>
  )
}
