'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { getJson, outcomeMessage, postJson } from '@/lib/api-client'
import { formatRupiah, parseRupiah } from '@/lib/money'
import { useIdempotencyKey } from '@/lib/use-idempotency-key'
import { OwnerPinDialog } from '@/components/ui/owner-pin-dialog'

export interface ExpenseRow {
  id: string
  kategori: string
  amount: number
  note: string | null
  paidFrom: string
  createdAt: string
}

export function ExpenseClient({
  hasOpenShift,
  initialExpenses,
  kategoriList,
}: {
  hasOpenShift: boolean
  initialExpenses: ExpenseRow[]
  kategoriList: string[]
}) {
  const [expenses, setExpenses] = useState(initialExpenses)
  const [kategori, setKategori] = useState(kategoriList[0] ?? 'Lainnya')
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [paidFrom, setPaidFrom] = useState<'CASH_DRAWER' | 'OTHER'>('CASH_DRAWER')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ExpenseRow | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Kunci sekali-pakai, berganti sendiri begitu isi formnya berubah. Tanpa ini,
  // menekan "Catat pengeluaran" dua kali karena response-nya tidak kembali akan
  // mencatat uang keluar dua kali (src/lib/idempotency.ts).
  const keyFor = useIdempotencyKey()

  const amount = (() => {
    try {
      return parseRupiah(text) ?? 0
    } catch {
      return 0
    }
  })()

  const refresh = useCallback(async () => {
    const outcome = await getJson<{ expenses: ExpenseRow[] }>('/api/expenses')
    if (outcome.kind === 'ok') setExpenses(outcome.data.expenses)
  }, [])

  const totalKas = expenses
    .filter((e) => e.paidFrom === 'CASH_DRAWER')
    .reduce((s, e) => s + e.amount, 0)

  // Kategori yang PERNAH dipakai di shift ini ikut muncul sebagai saran, walau
  // tidak ada di daftar bawaan. Kategori yang diketik sekali lalu hilang dari
  // saran akan diketik ulang dengan ejaan berbeda besok — dan laporan per
  // kategori langsung pecah menjadi dua baris yang maksudnya sama.
  const kategoriTerpakai = [...new Set(expenses.map((e) => e.kategori))]

  if (!hasOpenShift) {
    return (
      <div className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <p className="text-sm text-kasir-text">Belum ada shift terbuka.</p>
        <p className="mt-1 text-sm text-kasir-muted">
          Pengeluaran dicatat ke shift supaya ikut dalam rekonsiliasi kas.
        </p>
        <Link
          href="/shift"
          className="mt-3 flex h-12 items-center justify-center rounded-xl bg-kasir-accent text-base font-medium text-white"
        >
          Buka shift
        </Link>
      </div>
    )
  }

  return (
    <>
      <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <h2 className="text-base font-semibold text-kasir-text">Catat pengeluaran</h2>

        <KategoriField
          value={kategori}
          pilihan={kategoriList}
          terpakai={kategoriTerpakai}
          onChange={setKategori}
        />

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Nominal</span>
          <input
            type="text"
            inputMode="numeric"
            value={text}
            placeholder="0"
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-xl border border-kasir-border px-4 text-2xl"
          />
        </label>

        <fieldset className="mt-3">
          <legend className="mb-1 text-xs text-kasir-muted">Dibayar dari</legend>
          <div className="flex gap-2">
            <SourceButton
              label="Laci kas"
              active={paidFrom === 'CASH_DRAWER'}
              onClick={() => setPaidFrom('CASH_DRAWER')}
            />
            <SourceButton
              label="Lainnya"
              active={paidFrom === 'OTHER'}
              onClick={() => setPaidFrom('OTHER')}
            />
          </div>
          <p className="mt-1 text-xs text-kasir-muted">
            {paidFrom === 'CASH_DRAWER'
              ? 'Mengurangi uang yang seharusnya ada di laci saat tutup shift.'
              : 'Masuk laporan, tapi tidak menyentuh laci kas.'}
          </p>
        </fieldset>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-kasir-muted">Catatan (opsional)</span>
          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-kasir-border px-3 text-base"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={busy || amount < 1 || kategori.trim() === ''}
          onClick={async () => {
            setBusy(true)
            setError(null)
            const payload = {
              kategori: kategori.trim(),
              amount,
              note: note.trim() || undefined,
              paidFrom,
            }

            const idempotencyKey = keyFor(payload)
            if (idempotencyKey === null) {
              // Server MEWAJIBKAN kunci; mengirim tanpa kunci hanya menghasilkan
              // 400 berisi pesan teknis. Lebih jujur menyebut sebabnya di sini.
              setError(
                'Browser ini tidak bisa membuat kode pengaman, jadi pengeluaran tidak bisa dicatat. ' +
                  'Gunakan browser lain (Chrome/Firefox versi baru) di perangkat ini.',
              )
              setBusy(false)
              return
            }

            const outcome = await postJson('/api/expenses', { ...payload, idempotencyKey })
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            setText('')
            setNote('')
            await refresh()
          }}
          className="mt-4 h-14 w-full rounded-xl bg-kasir-accent text-lg font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Menyimpan…' : 'Catat pengeluaran'}
        </button>
      </section>

      <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-kasir-text">Shift ini</h2>
          <span className="text-sm text-kasir-muted">
            Dari laci: {formatRupiah(totalKas)}
          </span>
        </div>

        {expenses.length === 0 ? (
          <p className="mt-3 text-sm text-kasir-muted">Belum ada pengeluaran.</p>
        ) : (
          <ul className="mt-2 divide-y divide-kasir-border">
            {expenses.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-kasir-text">{e.kategori}</p>
                  {e.note && <p className="truncate text-xs text-kasir-muted">{e.note}</p>}
                  <p className="text-xs text-kasir-muted">
                    {e.paidFrom === 'CASH_DRAWER' ? 'Laci kas' : 'Lainnya'} ·{' '}
                    {new Date(e.createdAt).toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm text-kasir-text">{formatRupiah(e.amount)}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteError(null)
                      setDeleting(e)
                    }}
                    className="px-1 text-xs text-kasir-danger"
                  >
                    Hapus
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <OwnerPinDialog
          title="Hapus pengeluaran"
          description={`${deleting.kategori} — ${formatRupiah(deleting.amount)}`}
          confirmLabel="Hapus"
          reasonLabel="Alasan penghapusan"
          busy={busy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={async (ownerPin) => {
            setBusy(true)
            setDeleteError(null)
            const res = await fetch(`/api/expenses/${deleting.id}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ownerPin }),
            })
            setBusy(false)
            if (!res.ok) {
              const body: unknown = await res.json().catch(() => undefined)
              const message =
                typeof body === 'object' && body !== null && 'error' in body
                  ? ((body as { error: { message?: string } }).error.message ?? 'Gagal menghapus')
                  : 'Gagal menghapus'
              setDeleteError(message)
              return
            }
            setDeleting(null)
            await refresh()
          }}
        />
      )}
    </>
  )
}

function SourceButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-12 flex-1 rounded-xl border text-sm ${
        active
          ? 'border-kasir-accent bg-kasir-accent text-white'
          : 'border-kasir-border bg-kasir-surface text-kasir-text'
      }`}
    >
      {label}
    </button>
  )
}

/**
 * Kategori pengeluaran: bisa diketik, dicari, dan dibuat sendiri.
 *
 * `<input list=...>` dengan `<datalist>`, bukan `<select>`, dan bukan pula
 * pustaka combobox. Alasannya bukan kesederhanaan kode:
 *
 *  - Mengetik langsung menyaring daftar, jadi "Lis" cukup untuk sampai ke
 *    "Listrik" tanpa menggulir — di HP, menggulir <select> berisi sepuluh
 *    kategori dengan satu tangan sambil memegang uang itu menyebalkan.
 *  - Kategori baru cukup diketik. Tidak ada tombol "tambah kategori", tidak ada
 *    layar pengaturan yang harus dibuka lebih dulu, dan kasir tidak perlu
 *    menunggu pemilik untuk mencatat pengeluaran yang sudah terjadi.
 *  - Keyboard virtualnya tetap keyboard biasa, dan daftar sarannya dirender
 *    browser — tidak ada masalah fokus atau scroll yang biasa muncul pada
 *    combobox buatan sendiri di WebView Android.
 *
 * Yang tersimpan adalah teks apa adanya, jadi penyaringannya cuma bantuan
 * pengetikan; server tetap menerima string bebas maksimal 60 karakter.
 */
function KategoriField({
  value,
  pilihan,
  terpakai,
  onChange,
}: {
  value: string
  pilihan: string[]
  terpakai: string[]
  onChange: (v: string) => void
}) {
  const semua = [...new Set([...pilihan, ...terpakai])]
  const baru = value.trim() !== '' && !semua.some((k) => k.toLowerCase() === value.trim().toLowerCase())

  return (
    <label className="mt-3 block">
      <span className="mb-1 block text-xs text-kasir-muted">
        Kategori — ketik untuk mencari, atau tulis kategori baru
      </span>
      <input
        type="text"
        list="kategori-pengeluaran"
        value={value}
        maxLength={60}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-kasir-border bg-kasir-surface px-3 text-base"
      />
      <datalist id="kategori-pengeluaran">
        {semua.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {baru && (
        // Bukan peringatan, hanya pemberitahuan. Kategori baru memang boleh
        // dibuat — yang tidak boleh adalah membuatnya tanpa sadar karena salah
        // ketik, lalu laporan per kategori pecah menjadi "Transport" dan
        // "Transpor".
        <span className="mt-1 block text-xs text-kasir-muted">
          Kategori baru &ldquo;{value.trim()}&rdquo; akan dipakai.
        </span>
      )}
    </label>
  )
}
