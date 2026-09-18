import { z } from 'zod'
import { ok, route } from '@/lib/api'
import { prisma } from '@/lib/db/prisma'
import { RoleSchema } from '@/lib/enums'

export const dynamic = 'force-dynamic'

const UserListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
})
export type UserListItem = z.infer<typeof UserListItemSchema>

/**
 * Daftar user untuk layar login.
 *
 * Sengaja TIDAK terproteksi: halaman login harus bisa menampilkan siapa saja
 * yang bisa masuk sebelum ada yang login. Yang dikembalikan hanya id, nama, dan
 * role — tidak ada pinHash, tidak ada status lockout, tidak ada jumlah
 * percobaan gagal. Server ini berada di LAN toko tertutup, dan nama karyawan
 * memang sudah terpampang di depan kasir.
 */
export const GET = route('users.list', async () => {
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  })

  const items: UserListItem[] = []
  for (const u of users) {
    const parsed = UserListItemSchema.safeParse(u)
    if (parsed.success) items.push(parsed.data)
  }

  return ok({ users: items })
})
