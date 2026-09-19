import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { loadDashboard } from '@/lib/dashboard/service'
import { formatRupiah } from '@/lib/money'
import { getSetting } from '@/lib/settings'
import { BackupPanel } from './backup-panel'

export const dynamic = 'force-dynamic'

/**
 * Dashboard pemilik.
 *
 * Disusun untuk menjawab "apa yang butuh perhatian saya", bukan untuk memamerkan
 * angka. Karena itu urutannya: kewajiban manual lebih dulu, lalu keadaan sistem
 * (backup, pengiriman laporan, stok), baru angka penjualan. Yang mendesak di atas.
 */
export default async function DashboardPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')
  if (session.role !== 'OWNER') redirect('/kasir')

  const [data, storeName] = await Promise.all([loadDashboard(), getSetting('storeName')])

  return (
    <div className="flex min-h-dvh flex-col bg-kasir-bg">
      <Nav role={session.role} userName={session.name} />

      <main className="mx-auto w-full max-w-5xl flex-1 p-4">
        <header className="mb-4">
          <h1 className="text-xl font-semibold text-kasir-text">{storeName}</h1>
          <p className="text-sm text-kasir-muted">
            Hari usaha {data.businessDate} · {data.openShiftCount} shift terbuka
          </p>
        </header>

        {/* ── Kewajiban manual ──────────────────────────────────────────── */}
        <section className="mb-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <h2 className="mb-1 text-sm font-medium text-kasir-text">
            Butuh tindakan Anda{' '}
            {data.obligations.length > 0 && (
              <span className="text-kasir-danger">({data.obligations.length})</span>
            )}
          </h2>
          <p className="mb-3 text-xs text-kasir-muted">
            Hal yang tidak bisa diselesaikan sistem sendiri, {data.obligationDays} hari terakhir.
            Sistem tidak melacak apakah sudah Anda selesaikan — buktinya ada di mutasi rekening,
            bukan di sini.
          </p>

          {data.obligations.length === 0 ? (
            <p className="text-sm text-kasir-muted">
              Tidak ada. Tidak ada QRIS yang di-void setelah dibayar, dan tidak ada transaksi QRIS
              yang dibatalkan otomatis saat tutup shift.
            </p>
          ) : (
            <ul className="divide-y divide-kasir-border">
              {data.obligations.map((o) => (
                <li key={`${o.kind}-${o.transactionId}`} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <Link
                      href={`/transaksi/${o.transactionId}`}
                      className="font-medium text-kasir-text underline"
                    >
                      {o.trxNumber}
                    </Link>
                    <span className="font-medium text-kasir-text">{formatRupiah(o.amount)}</span>
                  </div>
                  <p className="mt-1 text-sm text-kasir-warning">{o.action}</p>
                  <p className="mt-1 text-xs text-kasir-muted">
                    {o.kind === 'VOID_QRIS_PAID'
                      ? 'QRIS sudah dibayar lalu transaksinya di-void'
                      : 'QRIS masih menunggu saat shift ditutup, lalu dibatalkan otomatis'}{' '}
                    · {o.businessDate} · kasir {o.cashierName}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Backup & export ──────────────────────────────────────────── */}
        <BackupPanel
          count={data.backup.count}
          latestFile={data.backup.latestFile}
          latestAt={data.backup.latestAt ? data.backup.latestAt.toISOString() : null}
          latestVerified={data.backup.latestVerified}
          latestTransactionCount={data.backup.latestTransactionCount}
          mirrorConfigured={data.backup.mirrorConfigured}
        />

        {/* ── Angka hari ini & bulan ini ───────────────────────────────── */}
        <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Penjualan bersih hari ini" value={formatRupiah(data.today.netSales)} />
          <Stat label="Laba kotor hari ini" value={formatRupiah(data.today.grossProfit)} />
          <Stat label="Transaksi hari ini" value={String(data.today.transactionCount)} />
          <Stat
            label="Rata-rata per transaksi"
            value={
              data.today.averageTransaction === null
                ? '—'
                : formatRupiah(data.today.averageTransaction)
            }
          />
          <Stat
            label={`Penjualan bersih ${data.monthKey}`}
            value={formatRupiah(data.month.netSales)}
          />
          <Stat label={`Laba kotor ${data.monthKey}`} value={formatRupiah(data.month.grossProfit)} />
          <Stat
            label="Selisih kas bulan ini"
            value={formatRupiah(data.month.cashDifferenceTotal)}
            warn={data.month.cashDifferenceTotal !== 0}
          />
          <Stat label="Pengeluaran bulan ini" value={formatRupiah(data.month.expenseTotal)} />
        </section>

        {/* ── Stok ────────────────────────────────────────────────────── */}
        <section className="mb-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <h2 className="mb-2 text-sm font-medium text-kasir-text">Stok</h2>
          <p className="text-sm text-kasir-muted">
            {data.lowStockCount} produk di bawah stok minimum
            {data.negativeStockCount > 0 && (
              <>
                {' · '}
                <span className="text-kasir-danger">
                  {data.negativeStockCount} produk stoknya MINUS
                </span>
              </>
            )}
          </p>
          <Link href="/produk" className="mt-2 inline-block text-sm underline">
            Buka daftar produk
          </Link>
        </section>

        {/* ── Pengiriman laporan ──────────────────────────────────────── */}
        <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-kasir-text">
              Pengiriman laporan
              {data.failedDeliveryCount > 0 && (
                <span className="text-kasir-danger"> · {data.failedDeliveryCount} gagal</span>
              )}
            </h2>
            <Link href="/laporan" className="text-sm underline">
              Buka laporan & kirim manual
            </Link>
          </div>

          {data.deliveries.length === 0 ? (
            <p className="text-sm text-kasir-muted">
              Belum ada pengiriman. Kalau Discord atau Telegram belum diisi, laporan otomatis memang
              tidak dikirim — dan itu tidak menghentikan apa pun di kasir.
            </p>
          ) : (
            <ul className="divide-y divide-kasir-border text-sm">
              {data.deliveries.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                  <span className="text-kasir-text">
                    {d.kind} {d.periodKey} → {d.channel}
                  </span>
                  <span
                    className={
                      d.status === 'SENT'
                        ? 'text-kasir-accent-strong'
                        : d.status === 'FAILED'
                          ? 'text-kasir-danger'
                          : 'text-kasir-muted'
                    }
                  >
                    {d.status}
                    {d.attempts > 1 && ` (${d.attempts}×)`}
                  </span>
                  {d.lastError && (
                    <span className="w-full text-xs text-kasir-muted">{d.lastError}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-kasir-border bg-kasir-surface p-3">
      <p className="text-xs text-kasir-muted">{label}</p>
      <p className={`text-base font-medium ${warn ? 'text-kasir-warning' : 'text-kasir-text'}`}>
        {value}
      </p>
    </div>
  )
}
