'use client'

import { useState } from 'react'
import { outcomeMessage, postJson } from '@/lib/api-client'

interface BackupResponse {
  ok: boolean
  file: string | null
  sizeBytes: number | null
  mirroredTo: string | null
  error: string | null
  verification: {
    ok: boolean
    integrity: string | null
    transactionCount: number | null
    error: string | null
  }
}

/**
 * Panel backup & export.
 *
 * Kalimat di panel ini dipilih hati-hati. "Backup tersimpan" dan "backup terbukti
 * bisa dibuka" adalah dua hal berbeda, dan hanya yang kedua berguna saat laptop
 * toko mati. Panel ini tidak pernah mengatakan yang pertama seolah-olah ia yang
 * kedua.
 */
export function BackupPanel({
  count,
  latestFile,
  latestAt,
  latestVerified,
  latestTransactionCount,
  mirrorConfigured,
}: {
  count: number
  latestFile: string | null
  latestAt: string | null
  latestVerified: boolean | null
  latestTransactionCount: number | null
  mirrorConfigured: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [hasil, setHasil] = useState<BackupResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const waktu = latestAt ? new Date(latestAt).toLocaleString('id-ID') : null

  return (
    <section className="mb-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
      <h2 className="mb-2 text-sm font-medium text-kasir-text">Backup & export</h2>

      {latestFile === null ? (
        <p className="text-sm text-kasir-danger">
          Belum ada backup sama sekali. Periksa log di data/logs/ — ini keadaan yang tidak boleh
          dibiarkan.
        </p>
      ) : (
        <p className="text-sm text-kasir-muted">
          {count} salinan. Terbaru <span className="text-kasir-text">{latestFile}</span>
          {waktu && ` · ${waktu}`}
          <br />
          {latestVerified === true && (
            <span className="text-kasir-accent-strong">
              Sudah diperiksa: berkasnya bisa dibuka dan memuat {latestTransactionCount} transaksi.
            </span>
          )}
          {latestVerified === false && (
            <span className="text-kasir-danger">
              GAGAL diperiksa — jangan andalkan backup terakhir. Jalankan backup ulang di bawah.
            </span>
          )}
          {latestVerified === null && (
            <span className="text-kasir-muted">
              Status pemeriksaan tidak diketahui (belum ada catatan). Jalankan backup sekarang untuk
              mendapatkannya.
            </span>
          )}
        </p>
      )}

      {!mirrorConfigured && (
        <p className="mt-2 text-sm text-kasir-warning">
          Semua backup masih di laptop ini saja. Kalau laptopnya rusak atau hilang, semuanya ikut
          hilang. Isi BACKUP_MIRROR_DIR di berkas .env — folder Google Drive sudah cukup.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            setHasil(null)
            const outcome = await postJson<BackupResponse>('/api/backup', {})
            setBusy(false)
            if (outcome.kind !== 'ok') {
              setError(outcomeMessage(outcome, false))
              return
            }
            setHasil(outcome.data)
          }}
          className="rounded-lg border border-kasir-border bg-kasir-bg px-4 py-2 text-sm text-kasir-text disabled:opacity-50"
        >
          {busy ? 'Membuat backup…' : 'Backup sekarang'}
        </button>

        {/*
          Tautan biasa, bukan fetch: unduhan berkas memang pekerjaan browser.
          Menariknya lewat JavaScript hanya akan menahan seluruh ZIP di memori
          tanpa satu pun manfaat.
        */}
        <a
          href="/api/export/csv"
          className="rounded-lg border border-kasir-border bg-kasir-bg px-4 py-2 text-sm text-kasir-text"
        >
          Export semua data ke CSV
        </a>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-kasir-danger">
          {error}
        </p>
      )}

      {hasil && (
        <p className="mt-2 text-sm">
          {hasil.ok && hasil.verification.ok ? (
            <span className="text-kasir-accent-strong">
              Selesai: {hasil.file} — diperiksa dan bisa dibuka, memuat{' '}
              {hasil.verification.transactionCount} transaksi.
              {hasil.mirroredTo
                ? ' Sudah disalin ke folder cadangan.'
                : mirrorConfigured
                  ? ' Penyalinan ke folder cadangan dilewati (folder tidak ditemukan).'
                  : ''}
            </span>
          ) : hasil.ok ? (
            <span className="text-kasir-danger">
              Berkas {hasil.file} dibuat, tapi GAGAL diperiksa:{' '}
              {hasil.verification.error ?? hasil.verification.integrity}. Jangan andalkan berkas ini.
            </span>
          ) : (
            <span className="text-kasir-danger">Backup gagal: {hasil.error}</span>
          )}
        </p>
      )}

      <p className="mt-3 text-xs text-kasir-muted">
        Backup otomatis berjalan setiap server menyala dan setiap tutup shift. Untuk memulihkan data
        setelah laptop rusak, yang dipakai adalah berkas .db di folder backups/ — caranya ada di
        README. Export CSV bukan untuk pemulihan.
      </p>
    </section>
  )
}
