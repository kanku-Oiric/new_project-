import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { config } from '@/lib/config'
import { prisma } from '@/lib/db/prisma'
import { formatRupiah } from '@/lib/money'
import { toBusinessDate } from '@/lib/time'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Lunas',
  PENDING: 'Belum selesai',
  VOIDED: 'Dibatalkan',
  CANCELLED: 'Dibatalkan',
}

export default async function TransaksiPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')

  const today = toBusinessDate(new Date(), config.timezone)

  const transactions = await prisma.transaction.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      cashier: { select: { name: true } },
      refunds: { select: { id: true } },
    },
  })

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-2xl p-4">
        <h1 className="mb-1 text-xl font-semibold text-kasir-text">Riwayat transaksi</h1>
        <p className="mb-4 text-sm text-kasir-muted">50 transaksi terakhir</p>

        {transactions.length === 0 ? (
          <p className="text-sm text-kasir-muted">Belum ada transaksi.</p>
        ) : (
          <ul className="divide-y divide-kasir-border rounded-xl border border-kasir-border bg-kasir-surface">
            {transactions.map((t) => (
              <li key={t.id}>
                <Link href={`/transaksi/${t.id}`} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-kasir-text">{t.trxNumber}</p>
                    <p className="text-xs text-kasir-muted">
                      {t.cashier.name} ·{' '}
                      {new Date(t.createdAt).toLocaleString('id-ID', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {t.businessDate === today ? ' · hari ini' : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm text-kasir-text">{formatRupiah(t.netTotal)}</p>
                    <p
                      className={`text-xs ${
                        t.status === 'COMPLETED' ? 'text-kasir-muted' : 'text-kasir-danger'
                      }`}
                    >
                      {STATUS_LABEL[t.status] ?? t.status}
                      {t.refunds.length > 0 ? ' · ada refund' : ''}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  )
}
