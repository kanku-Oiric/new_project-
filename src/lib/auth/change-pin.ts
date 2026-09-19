import 'server-only'
import { recordAuditSafe } from '../audit'
import { prisma } from '../db/prisma'
import { ForbiddenError, ValidationError } from '../errors'
import type { Role } from '../enums'
import { PinSchema, hashPin, isWeakPin, verifyPin } from './pin'

/**
 * Ganti PIN sendiri.
 *
 * PIN bawaan dari seed tidak boleh terbawa ke toko. Setiap user seed ditandai
 * `mustChangePin`, dan aplikasi menahannya di layar ganti PIN sampai diganti.
 */
export async function changeOwnPin(
  actor: { userId: string; role: Role; name: string },
  currentPin: string,
  newPin: string,
): Promise<void> {
  const parsed = PinSchema.parse(newPin)

  if (parsed === currentPin) {
    throw new ValidationError('PIN baru tidak boleh sama dengan PIN lama')
  }
  if (isWeakPin(parsed)) {
    throw new ValidationError(
      'PIN terlalu mudah ditebak. Hindari angka berurutan atau berulang seperti 1234 atau 1111.',
    )
  }

  const user = await prisma.user.findUnique({ where: { id: actor.userId } })
  if (!user) throw new ForbiddenError('Pengguna tidak ditemukan')

  // PIN lama tetap diverifikasi walaupun sudah login: device yang ditinggalkan
  // dalam keadaan terbuka tidak boleh cukup untuk mengunci pemiliknya keluar.
  if (!(await verifyPin(currentPin, user.pinHash))) {
    throw new ForbiddenError('PIN lama salah')
  }

  await prisma.user.update({
    where: { id: actor.userId },
    data: { pinHash: await hashPin(parsed), mustChangePin: false },
  })

  await recordAuditSafe(
    { userId: actor.userId, role: actor.role },
    {
      action: 'USER_UPDATE',
      summary: `${actor.name} mengganti PIN sendiri`,
      entityType: 'User',
      entityId: actor.userId,
      // Tidak pernah mencatat PIN, lama maupun baru — audit log dibaca manusia.
      after: { mustChangePin: false },
    },
  )
}
