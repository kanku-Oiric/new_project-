'use client'

import { formatRupiah } from '@/lib/money'

/**
 * Layar tunggu pembayaran QRIS statis.
 *
 * Referensi: docs/qris.md §3
 *
 * Tidak ada polling yang melunaskan, tidak ada hitungan detik, tidak ada
 * `setTimeout` yang mengubah status. Satu-satunya jalan transaksi ini menjadi
 * lunas adalah tombol "Pembayaran diterima" di bawah, dan kalimat di layar
 * mengatakan itu apa adanya — kasir perlu tahu bahwa tanggung jawab memastikan
 * uang masuk ada padanya, bukan pada sistem.
 */
export function QrisPending({
  trxNumber,
  amount,
  qrImageUrl,
  storedStatus,
  busy,
  error,
  onConfirm,
  onCancel,
  onRefreshStatus,
}: {
  trxNumber: string
  amount: number
  qrImageUrl: string | null
  /** Status terakhir yang dibaca dari server, kalau kasir menekan periksa. */
  storedStatus: string | null
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  onRefreshStatus: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Menunggu pembayaran QRIS"
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/40 p-0 sm:items-center sm:p-4"
    >
      <div className="w-full max-w-md rounded-t-2xl bg-kasir-surface p-4 sm:rounded-2xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-kasir-text">Menunggu pembayaran QRIS</h2>
          <span className="text-xs text-kasir-muted">{trxNumber}</span>
        </div>

        <p className="mt-1 text-3xl font-semibold text-kasir-text">{formatRupiah(amount)}</p>

        {qrImageUrl ? (
          <div className="mt-3 flex justify-center rounded-xl border border-kasir-border bg-white p-3">
            {/* next/image tidak dipakai di sini: gambarnya dilayani route yang
                memeriksa session, sedangkan pengoptimalnya mengambil URL tanpa
                cookie dan akan menerima 401. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrImageUrl}
              alt="Kode QRIS statis toko"
              className="h-56 w-56 object-contain"
            />
          </div>
        ) : (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-kasir-danger">
            Gambar QR tidak bisa dimuat. Minta pelanggan membayar tunai, atau hubungi pemilik.
          </p>
        )}

        <p className="mt-3 text-sm text-kasir-text">
          Pelanggan scan QR di atas, lalu <strong>periksa notifikasi masuk di HP kamu</strong>{' '}
          sebelum menekan konfirmasi.
        </p>
        <p className="mt-1 text-xs text-kasir-muted">
          Sistem tidak memeriksa pembayaran secara otomatis. Status hanya berubah karena kamu
          menekan tombol, dan namamu tercatat pada transaksi ini.
        </p>

        {storedStatus && (
          <p className="mt-3 rounded-lg bg-kasir-bg px-3 py-2 text-sm text-kasir-text">
            Status tersimpan di server: <strong>{storedStatus}</strong>
          </p>
        )}

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
            className="h-14 flex-1 rounded-xl border border-kasir-border text-base disabled:opacity-40"
          >
            Batalkan
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-14 flex-[2] rounded-xl bg-kasir-accent text-base font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Memproses…' : 'Pembayaran diterima'}
          </button>
        </div>

        <button
          type="button"
          onClick={onRefreshStatus}
          disabled={busy}
          className="mt-2 h-10 w-full rounded-xl text-sm text-kasir-muted underline disabled:opacity-40"
        >
          Periksa status tersimpan
        </button>
      </div>
    </div>
  )
}
