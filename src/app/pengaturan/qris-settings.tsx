'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { outcomeMessage, patchJson } from '@/lib/api-client'
import { OwnerPinDialog } from '@/components/ui/owner-pin-dialog'

/**
 * Pengaturan QRIS: satu tombol nyala/mati, dan tidak ada yang lain.
 *
 * Dulu bagian ini juga mengunggah gambar QR statis, lalu menegakkan urutan
 * "gambar dulu, baru boleh dinyalakan". Semuanya hilang bersama alurnya: toko
 * memakai QRIS soundbox, QR-nya tertempel permanen di meja, dan tidak pernah
 * ditampilkan di layar siapa pun. Gambar yang tidak pernah dibuka bukan
 * konfigurasi — ia cuma berkas yang harus dijaga.
 *
 * Yang menggantikan syarat itu adalah kenyataan fisik: kalau kotaknya belum
 * terpasang, pemiliknya tidak akan menyalakan QRIS.
 */
export function QrisSettings({ enabled }: { enabled: boolean }) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <h2 className="text-base font-semibold text-kasir-text">QRIS soundbox</h2>
      <p className="mt-1 text-sm text-kasir-muted">
        QR sudah tertempel di meja dan kotaknya berbunyi saat pembayaran masuk. Kasir menekan
        tombol QRIS <strong>setelah</strong> mendengar bunyinya, dan transaksi langsung tercatat
        lunas — tidak ada layar QR dan tidak ada konfirmasi kedua.
      </p>

      {notice && (
        <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-kasir-accent-strong">
          {notice}
        </p>
      )}

      <div className="mt-3 rounded-xl border border-kasir-border p-3">
        <p className="text-xs text-kasir-muted">Keadaan sekarang</p>
        <p className="mt-1 text-sm text-kasir-text">
          {enabled
            ? 'Aktif — tombol QRIS bisa ditekan di layar kasir.'
            : 'Mati — tombol QRIS di layar kasir tidak bisa ditekan.'}
        </p>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setError(null)
          setAsking(true)
        }}
        className="mt-3 h-12 w-full rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
      >
        {enabled ? 'Matikan QRIS' : 'Aktifkan QRIS'}
      </button>

      {asking && (
        <OwnerPinDialog
          title={enabled ? 'Matikan QRIS' : 'Aktifkan QRIS'}
          description={
            enabled
              ? 'Tombol QRIS di layar kasir akan mati. Transaksi tunai tidak terpengaruh.'
              : 'Tombol QRIS akan aktif di layar kasir. Pastikan soundbox sudah terpasang dan QR-nya tertempel di meja.'
          }
          confirmLabel={enabled ? 'Matikan' : 'Aktifkan'}
          reasonLabel={null}
          tone={enabled ? 'danger' : 'accent'}
          busy={busy}
          error={error}
          onCancel={() => setAsking(false)}
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
            setAsking(false)
            setNotice(
              enabled ? 'QRIS dimatikan.' : 'QRIS soundbox aktif (kasir menekan setelah bunyi).',
            )
            router.refresh()
          }}
        />
      )}
    </section>
  )
}
