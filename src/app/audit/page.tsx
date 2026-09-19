import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

export default async function AuditPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')
  if (session.role !== 'OWNER') redirect('/kasir')

  const logs = await prisma.auditLog.findMany({ orderBy: { at: 'desc' }, take: 100 })

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-3xl p-4">
        <h1 className="mb-1 text-xl font-semibold text-kasir-text">Audit log</h1>
        <p className="mb-4 text-sm text-kasir-muted">
          100 peristiwa terakhir. Catatan ini hanya bisa dibaca — tidak ada jalur untuk
          mengubah atau menghapusnya, termasuk bagi pemilik.
        </p>

        {logs.length === 0 ? (
          <p className="text-sm text-kasir-muted">Belum ada catatan.</p>
        ) : (
          <ul className="divide-y divide-kasir-border rounded-xl border border-kasir-border bg-kasir-surface">
            {logs.map((l) => (
              <li key={l.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded bg-kasir-bg px-2 py-0.5 text-xs text-kasir-text">
                    {l.action}
                  </span>
                  <span className="shrink-0 text-xs text-kasir-muted">
                    {new Date(l.at).toLocaleString('id-ID')}
                  </span>
                </div>
                <p className="mt-1 text-sm text-kasir-text">{l.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  )
}
