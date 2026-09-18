import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db/prisma'
import { getSession } from '@/lib/auth/session'
import { getSetting } from '@/lib/settings'
import { RoleSchema, type Role } from '@/lib/enums'
import { LoginForm, type LoginUser } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  const session = await getSession()
  if (session) redirect('/')

  const rows = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  })

  const users: LoginUser[] = []
  for (const r of rows) {
    const role = RoleSchema.safeParse(r.role)
    if (role.success) {
      users.push({ id: r.id, name: r.name, role: role.data as Role })
    }
  }

  const storeName = await getSetting('storeName')

  return (
    <main className="flex min-h-dvh items-center justify-center bg-kasir-bg p-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-semibold text-kasir-text">{storeName}</h1>
        <p className="mb-6 text-center text-sm text-kasir-muted">Pilih nama, lalu masukkan PIN</p>

        {users.length === 0 ? (
          <div className="rounded-xl border border-kasir-border bg-kasir-surface p-5 text-center">
            <p className="text-sm text-kasir-text">Belum ada pengguna.</p>
            <p className="mt-2 text-xs text-kasir-muted">
              Jalankan <code className="rounded bg-kasir-bg px-1 py-0.5">npm run db:seed</code> di
              komputer server.
            </p>
          </div>
        ) : (
          <LoginForm users={users} />
        )}
      </div>
    </main>
  )
}
