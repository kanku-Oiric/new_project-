'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { outcomeMessage, patchJson, postForm } from '@/lib/api-client'
import { OwnerPinDialog } from '@/components/ui/owner-pin-dialog'
import { UPLOAD_MAX_BYTES } from '@/lib/uploads-limits'

/**
 * Pengaturan QRIS statis: unggah gambar QR, lalu nyalakan.
 *
 * Urutannya memang begitu dan ditegakkan server: menyalakan QRIS tanpa gambar
 * akan ditolak, karena kasir yang menekan "Bayar dengan QRIS" harus punya
 * sesuatu untuk ditunjukkan ke pelanggan.
 */
export function QrisSettings({
  enabled,
  imageName,
}: {
  enabled: boolean
  imageName: string
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [mode, setMode] = useState<'none' | 'upload' | 'toggle'>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <h2 className="text-base font-semibold text-kasir-text">QRIS statis</h2>
      <p className="mt-1 text-sm text-kasir-muted">
        Gambar QR bawaan dari bank atau dompet digital toko. Pelanggan scan gambar yang sama untuk
        setiap transaksi, lalu kasir mengonfirmasi setelah notifikasi masuk terlihat.
      </p>

      {notice && (
        <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-kasir-accent-strong">
          {notice}
        </p>
      )}

      <div className="mt-3 rounded-xl border border-kasir-border p-3">
        <p className="text-xs text-kasir-muted">Gambar QR tersimpan</p>
        {imageName ? (
          <div className="mt-2 flex items-start gap-3">
            {/* next/image tidak dipakai: gambar ini dilayani route yang memeriksa
                session, sedangkan pengoptimalnya mengambil URL tanpa cookie. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/uploads/${imageName}`}
              alt="Kode QRIS statis toko"
              className="h-32 w-32 rounded-lg border border-kasir-border bg-white object-contain p-1"
            />
            <p className="min-w-0 break-all text-xs text-kasir-muted">{imageName}</p>
          </div>
        ) : (
          <p className="mt-1 text-sm text-kasir-text">Belum ada. Unggah gambar QR dulu.</p>
        )}
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-kasir-muted">
          Pilih gambar QR baru (PNG, JPG, atau WEBP · maksimal {UPLOAD_MAX_BYTES / 1024} KB)
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            setError(null)
            setNotice(null)
            setFileName(e.target.files?.[0]?.name ?? null)
          }}
          className="w-full rounded-lg border border-kasir-border px-3 py-2 text-sm"
        />
      </label>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !fileName}
          onClick={() => {
            setError(null)
            setMode('upload')
          }}
          className="h-12 flex-1 rounded-xl border border-kasir-border text-base text-kasir-text disabled:opacity-40"
        >
          Unggah gambar QR
        </button>
        <button
          type="button"
          disabled={busy || (!enabled && !imageName)}
          onClick={() => {
            setError(null)
            setMode('toggle')
          }}
          className="h-12 flex-1 rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
        >
          {enabled ? 'Matikan QRIS' : 'Aktifkan QRIS'}
        </button>
      </div>
      {!enabled && !imageName && (
        <p className="mt-1 text-xs text-kasir-muted">
          QRIS belum bisa dinyalakan karena gambar QR belum diunggah.
        </p>
      )}

      {mode === 'upload' && (
        <OwnerPinDialog
          title="Unggah gambar QRIS"
          description={fileName ?? undefined}
          confirmLabel="Unggah"
          reasonLabel={null}
          tone="accent"
          busy={busy}
          error={error}
          onCancel={() => setMode('none')}
          onConfirm={async (ownerPin) => {
            const file = fileRef.current?.files?.[0]
            if (!file) {
              setError('Berkas tidak terbaca. Pilih ulang gambarnya.')
              return
            }
            setBusy(true)
            setError(null)

            const form = new FormData()
            form.set('ownerPin', ownerPin)
            form.set('file', file)

            const outcome = await postForm<{ qrisImagePath: string }>(
              '/api/settings/qris-image',
              form,
            )
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            setMode('none')
            setFileName(null)
            if (fileRef.current) fileRef.current.value = ''
            setNotice(
              enabled
                ? 'Gambar QR diperbarui.'
                : 'Gambar QR tersimpan. Sekarang QRIS bisa diaktifkan.',
            )
            router.refresh()
          }}
        />
      )}

      {mode === 'toggle' && (
        <OwnerPinDialog
          title={enabled ? 'Matikan QRIS' : 'Aktifkan QRIS'}
          description={
            enabled
              ? 'Tombol QRIS di layar kasir akan mati. Transaksi tunai tidak terpengaruh.'
              : 'Tombol QRIS akan aktif di layar kasir, dengan konfirmasi manual.'
          }
          confirmLabel={enabled ? 'Matikan' : 'Aktifkan'}
          reasonLabel={null}
          tone={enabled ? 'danger' : 'accent'}
          busy={busy}
          error={error}
          onCancel={() => setMode('none')}
          onConfirm={async (ownerPin) => {
            setBusy(true)
            setError(null)
            const outcome = await patchJson('/api/settings', {
              ownerPin,
              values: { qrisEnabled: enabled ? 'false' : 'true' },
            })
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, true))
              return
            }
            setMode('none')
            setNotice(enabled ? 'QRIS dimatikan.' : 'QRIS statis aktif (konfirmasi manual kasir).')
            router.refresh()
          }}
        />
      )}
    </section>
  )
}
