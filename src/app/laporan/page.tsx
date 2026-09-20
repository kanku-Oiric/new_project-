import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { config } from '@/lib/config'
import { prisma } from '@/lib/db/prisma'
import { ReportKindSchema, type ReportKind } from '@/lib/enums'
import { listNotificationProviders } from '@/lib/notify/registry'
import { buildReport } from '@/lib/report/service'
import { isPeriodComplete, isValidPeriodKey, periodKeyFor } from '@/lib/schedule'
import { toBusinessDate } from '@/lib/time'
import { readCachedInsight } from '@/lib/ai/cache'
import { ReportControls, type DeliveryRow } from './report-controls'

export const dynamic = 'force-dynamic'

/**
 * Halaman laporan.
 *
 * Yang ditampilkan di layar adalah OBJEK PESAN YANG SAMA dengan yang dikirim ke
 * Discord/Telegram — bukan susunan angka kedua yang dirawat terpisah. Dengan
 * begitu tidak mungkin layar menunjukkan angka yang berbeda dari laporan yang
 * diterima pemilik di HP-nya.
 */
export default async function LaporanPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; period?: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')
  if (session.role !== 'OWNER') redirect('/kasir')

  const params = await searchParams
  const kind: ReportKind = ReportKindSchema.catch('DAILY').parse(params.kind)
  const today = toBusinessDate(new Date(), config.timezone)
  const fallbackKey = periodKeyFor(kind, today)
  const periodKey =
    params.period && isValidPeriodKey(kind, params.period) ? params.period : fallbackKey

  const [report, deliveries, providers, cachedInsight] = await Promise.all([
    buildReport(kind, periodKey),
    prisma.reportDelivery.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    Promise.all(
      listNotificationProviders().map(async (p) => ({
        channel: p.channel,
        ...(await p.describe()),
      })),
    ),
    // Pembacaan cache, bukan panggilan API. Membuka halaman ini tidak pernah
    // menghabiskan kuota harian (docs/architecture.md §12.1).
    kind === 'DAILY' ? Promise.resolve(null) : readCachedInsight(kind, periodKey),
  ])

  const selesai = isPeriodComplete(kind, periodKey, today)

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-3xl p-4">
        <h1 className="text-xl font-semibold text-kasir-text">Laporan</h1>
        <p className="mb-4 text-sm text-kasir-muted">
          Semua angka dihitung ulang dari transaksi mentah setiap kali halaman ini dibuka. Tidak
          ada angka ringkasan yang disimpan.
        </p>

        <ReportControls
          kind={kind}
          periodKey={periodKey}
          periodLabel={report.label}
          periodComplete={selesai}
          channels={providers}
          deliveries={deliveries satisfies DeliveryRow[]}
          aiEnabled={config.ai.enabled}
          aiCached={
            cachedInsight
              ? {
                  text: cachedInsight.text,
                  model: cachedInsight.model,
                  createdAt: cachedInsight.createdAt.toISOString(),
                }
              : null
          }
        />

        <section className="mt-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <h2 className="text-base font-semibold text-kasir-text">{report.message.title}</h2>
          <p className="text-sm text-kasir-muted">{report.message.periodLabel}</p>

          {report.aggregate.transactionCount === 0 && (
            <p className="mt-3 rounded-lg bg-kasir-bg px-3 py-2 text-sm text-kasir-muted">
              Belum ada transaksi selesai pada periode ini.
            </p>
          )}

          <div className="mt-3 space-y-4">
            {report.message.sections.map((section) => (
              <div key={section.label}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-kasir-muted">
                  {section.label}
                </h3>
                <dl className="mt-1 divide-y divide-kasir-border">
                  {section.rows.map((r) => (
                    <div key={`${section.label}-${r.label}`} className="flex justify-between py-1.5">
                      <dt
                        className={`text-sm ${
                          r.emphasis ? 'font-medium text-kasir-text' : 'text-kasir-muted'
                        }`}
                      >
                        {r.label}
                      </dt>
                      <dd
                        className={`text-sm ${
                          r.emphasis ? 'font-semibold text-kasir-text' : 'text-kasir-text'
                        }`}
                      >
                        {r.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>

          {report.message.footnotes && (
            <ul className="mt-4 space-y-1 border-t border-kasir-border pt-3">
              {report.message.footnotes.map((note) => (
                <li key={note} className="text-xs text-kasir-muted">
                  {note}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  )
}
