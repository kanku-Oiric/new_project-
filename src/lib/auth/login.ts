import 'server-only'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { recordAuditSafe } from '../audit'
import { ForbiddenError, LockedError } from '../errors'
import { RoleSchema, type Role } from '../enums'
import { burnVerifyTime, verifyPin } from './pin'
import { createSession } from './session'

/**
 * Login PIN dengan lockout berjenjang.
 *
 * PIN entropi rendah hanya aman kalau percobaan dibatasi. Lockout-nya berjenjang
 * (5 menit × kelipatan di atas ambang) supaya tebakan beruntun jadi tidak
 * praktis, tapi kasir yang cuma salah pencet tidak terkunci lama.
 */

export interface LoginContext {
  ip?: string | null
  deviceLabel?: string | null
}

export interface LoginResult {
  id: string
  name: string
  role: Role
  mustChangePin: boolean
}

function lockoutMinutesFor(failedAttempts: number): number {
  const over = failedAttempts - config.auth.maxFailedAttempts + 1
  return config.auth.lockoutMinutes * Math.max(1, over)
}

function remainingLockSeconds(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000))
}

export async function login(
  userId: string,
  pin: string,
  ctx: LoginContext = {},
  now: Date = new Date(),
): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } })

  // User tidak ada atau nonaktif: tetap jalankan bcrypt supaya waktu respons
  // tidak membocorkan user mana yang valid.
  if (!user || !user.active) {
    await burnVerifyTime()
    await recordAuditSafe(
      { userId: null, role: null, ip: ctx.ip, deviceLabel: ctx.deviceLabel },
      {
        action: 'LOGIN_FAILED',
        summary: `Percobaan login untuk user tidak dikenal/nonaktif (${userId})`,
        entityType: 'User',
        entityId: userId,
      },
    )
    throw new ForbiddenError('PIN salah')
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    const seconds = remainingLockSeconds(user.lockedUntil, now)
    throw new LockedError(
      `Akun terkunci sementara. Coba lagi dalam ${Math.ceil(seconds / 60)} menit.`,
    )
  }

  const ok = await verifyPin(pin, user.pinHash)

  if (!ok) {
    const failedAttempts = user.failedAttempts + 1
    const shouldLock = failedAttempts >= config.auth.maxFailedAttempts
    const lockedUntil = shouldLock
      ? new Date(now.getTime() + lockoutMinutesFor(failedAttempts) * 60_000)
      : null

    await prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts, lockedUntil },
    })

    await recordAuditSafe(
      { userId: user.id, role: null, ip: ctx.ip, deviceLabel: ctx.deviceLabel },
      {
        action: 'LOGIN_FAILED',
        summary: `PIN salah untuk ${user.name} (percobaan ke-${failedAttempts})`,
        entityType: 'User',
        entityId: user.id,
      },
    )

    if (lockedUntil) {
      throw new LockedError(
        `PIN salah ${failedAttempts} kali. Akun terkunci ${lockoutMinutesFor(failedAttempts)} menit.`,
      )
    }
    const sisa = config.auth.maxFailedAttempts - failedAttempts
    throw new ForbiddenError(`PIN salah. Sisa ${sisa} percobaan sebelum akun terkunci.`)
  }

  const role = RoleSchema.parse(user.role)

  await prisma.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null },
  })

  await createSession(user.id, ctx)

  await recordAuditSafe(
    { userId: user.id, role, ip: ctx.ip, deviceLabel: ctx.deviceLabel },
    { action: 'LOGIN', summary: `${user.name} login`, entityType: 'User', entityId: user.id },
  )

  return {
    id: user.id,
    name: user.name,
    role,
    mustChangePin: user.mustChangePin,
  }
}

/**
 * Verifikasi PIN owner untuk aksi sensitif (void, refund, hapus pengeluaran,
 * ubah pengaturan).
 *
 * Sengaja TIDAK memakai session: kasir yang meninggalkan device dalam keadaan
 * login tidak boleh otomatis memberi akses owner. PIN harus dimasukkan ulang
 * setiap kali, dan siapa yang mengotorisasi dicatat di audit log.
 *
 * Mengembalikan id owner yang mengotorisasi.
 */
export async function verifyOwnerPin(pin: string, now: Date = new Date()): Promise<string> {
  const owners = await prisma.user.findMany({
    where: { role: 'OWNER', active: true },
    orderBy: { createdAt: 'asc' },
  })

  if (owners.length === 0) {
    await burnVerifyTime()
    throw new ForbiddenError('Tidak ada akun pemilik yang aktif')
  }

  for (const owner of owners) {
    if (owner.lockedUntil && owner.lockedUntil.getTime() > now.getTime()) continue
    if (await verifyPin(pin, owner.pinHash)) {
      await prisma.user.update({
        where: { id: owner.id },
        data: { failedAttempts: 0, lockedUntil: null },
      })
      return owner.id
    }
  }

  // Semua owner gagal → naikkan hitungan gagal pada owner pertama supaya
  // tebakan beruntun tetap kena lockout, bukan bisa dicoba tanpa batas.
  const primary = owners[0]
  if (primary) {
    const failedAttempts = primary.failedAttempts + 1
    const lockedUntil =
      failedAttempts >= config.auth.maxFailedAttempts
        ? new Date(now.getTime() + lockoutMinutesFor(failedAttempts) * 60_000)
        : null
    await prisma.user.update({
      where: { id: primary.id },
      data: { failedAttempts, lockedUntil },
    })
  }

  await recordAuditSafe(
    { userId: null, role: null },
    { action: 'LOGIN_FAILED', summary: 'PIN pemilik salah saat otorisasi aksi sensitif' },
  )

  throw new ForbiddenError('PIN pemilik salah')
}
