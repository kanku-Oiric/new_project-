import Link from 'next/link'
import type { Role } from '@/lib/enums'

const LINKS: { href: string; label: string; ownerOnly?: boolean }[] = [
  { href: '/kasir', label: 'Kasir' },
  { href: '/shift', label: 'Shift' },
  { href: '/pengeluaran', label: 'Pengeluaran' },
  { href: '/transaksi', label: 'Transaksi' },
  { href: '/produk', label: 'Produk', ownerOnly: true },
  { href: '/audit', label: 'Audit', ownerOnly: true },
]

export function Nav({ role, userName }: { role: Role; userName: string }) {
  const links = LINKS.filter((l) => !l.ownerOnly || role === 'OWNER')

  return (
    <header className="no-print border-b border-kasir-border bg-kasir-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-1 gap-y-1 px-3 py-2">
        <nav className="flex flex-1 flex-wrap gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-2 text-sm text-kasir-text hover:bg-kasir-bg"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <Link href="/ganti-pin" className="px-3 py-2 text-sm text-kasir-muted hover:underline">
          {userName}
        </Link>
      </div>
    </header>
  )
}
