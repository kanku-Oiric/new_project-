import { redirect } from 'next/navigation'
import { listBackups } from '@/lib/backup'
import { config } from '@/lib/config'
import { prisma } from '@/lib/db/prisma'
import { getSession } from '@/lib/auth/session'
import { getSetting } from '@/lib/settings'
import { formatRupiah } from '@/lib/money'
import { toBusinessDate } from '@/lib/time'
import { LogoutButton } from './logout-button'

export const dynamic = 'force-dynamic'

/**
 * Halaman sementara Fase 1: bukti bahwa login, database, dan backup bekerja
 * dari device mana pun di LAN. Digantikan layar kasir di Fase 2.
 */
export default async function BerandaPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const [storeName, productCount, userCount, sampleProducts] = await Promise.all([
    getSetting('storeName'),
    prisma.product.count({ where: { aktif: true } }),
    prisma.user.count({ where: { active: true } }),
    prisma.product.findMany({
      where: { aktif: true },
      orderBy: { nama: 'asc' },
      take: 5,
      select: { id: true, nama: true, hargaJual: true, stok: true, satuan: true },
    }),
  ])

  const backups = listBackups()
  const latestBackup = backups[0] ?? null
  const businessDate = toBusinessDate(new Date(), config.timezone)

  return (
    <main className="mx-auto min-h-dvh w-full max-w-2xl p-4">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-kasir-text">{storeName}</h1>
          <p className="text-sm text-kasir-muted">
            {session.name} · {session.role === 'OWNER' ? 'Pemilik' : 'Kasir'}
          </p>
        </div>
        <LogoutButton />
      </header>

      {session.mustChangePin && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-kasir-warning">
          PIN masih PIN bawaan dari seed. Ganti sebelum sistem dipakai di toko.
        </p>
      )}

      <section className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="Hari usaha" value={businessDate} />
        <Stat label="Zona waktu" value={config.timezone} />
        <Stat label="Produk aktif" value={String(productCount)} />
        <Stat label="Pengguna aktif" value={String(userCount)} />
      </section>

      <section className="mb-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <h2 className="mb-2 text-sm font-medium text-kasir-text">Backup</h2>
        {latestBackup ? (
          <p className="text-sm text-kasir-muted">
            {backups.length} salinan tersimpan. Terbaru:{' '}
            <span className="text-kasir-text">{latestBackup.file}</span>
          </p>
        ) : (
          <p className="text-sm text-kasir-danger">
            Belum ada backup. Periksa log di data/logs/.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-kasir-border bg-kasir-surface p-4">
        <h2 className="mb-3 text-sm font-medium text-kasir-text">Contoh produk</h2>
        <ul className="divide-y divide-kasir-border">
          {sampleProducts.map((p) => (
            <li key={p.id} className="flex items-center justify-between py-2">
              <span className="text-sm text-kasir-text">{p.nama}</span>
              <span className="text-sm text-kasir-muted">
                {formatRupiah(p.hargaJual)} · {p.stok} {p.satuan}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-kasir-muted">
          Layar kasir menyusul di Fase 2.
        </p>
      </section>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-kasir-border bg-kasir-surface p-3">
      <p className="text-xs text-kasir-muted">{label}</p>
      <p className="text-base font-medium text-kasir-text">{value}</p>
    </div>
  )
}
