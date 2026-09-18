import 'server-only'
import { cookies } from 'next/headers'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { UnauthenticatedError, ForbiddenError } from '../errors'
import { RoleSchema, type Role } from '../enums'
import { generateSessionToken, hashSessionToken } from './pin'

export interface SessionUser {
  id: string
  name: string
  role: Role
  mustChangePin: boolean
}

/**
 * Buat session baru dan set cookie.
 *
 * Catatan jujur soal `secure`: LAN toko berjalan HTTP tanpa TLS, jadi flag
 * `secure` TIDAK dipakai — kalau dipakai, browser akan menolak menyimpan cookie
 * dan tidak ada yang bisa login. Ini dapat diterima untuk jaringan tertutup di
 * dalam satu toko, dan ditulis apa adanya di README, bukan disembunyikan.
 */
export async function createSession(
  userId: string,
  meta: { ip?: string | null; deviceLabel?: string | null } = {},
): Promise<string> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlHours * 3_600_000)

  await prisma.session.create({
    data: {
      id: hashSessionToken(token),
      userId,
      expiresAt,
      ip: meta.ip ?? null,
      deviceLabel: meta.deviceLabel ?? null,
    },
  })

  const store = await cookies()
  store.set(config.auth.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // lihat catatan di atas — LAN HTTP tanpa TLS
    path: '/',
    expires: expiresAt,
  })

  return token
}

/**
 * Baca session dari cookie. Mengembalikan null kalau tidak ada / kedaluwarsa /
 * user dinonaktifkan — TIDAK melempar, supaya halaman publik bisa memakainya.
 *
 * Sliding expiry: setiap akses memperpanjang masa berlaku, sehingga kasir yang
 * aktif sepanjang shift tidak tiba-tiba terlempar keluar di tengah transaksi.
 */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies()
  const token = store.get(config.auth.sessionCookieName)?.value
  if (!token) return null

  const row = await prisma.session.findUnique({
    where: { id: hashSessionToken(token) },
    include: { user: true },
  })

  if (!row) return null

  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: row.id } }).catch(() => undefined)
    return null
  }

  // User yang dinonaktifkan kehilangan akses seketika, tanpa menunggu session
  // habis — penting saat karyawan berhenti di tengah hari.
  if (!row.user.active) {
    await prisma.session.delete({ where: { id: row.id } }).catch(() => undefined)
    return null
  }

  const parsedRole = RoleSchema.safeParse(row.user.role)
  if (!parsedRole.success) return null

  const nextExpiry = new Date(Date.now() + config.auth.sessionTtlHours * 3_600_000)
  await prisma.session
    .update({
      where: { id: row.id },
      data: { lastSeenAt: new Date(), expiresAt: nextExpiry },
    })
    .catch(() => undefined)

  return {
    id: row.user.id,
    name: row.user.name,
    role: parsedRole.data,
    mustChangePin: row.user.mustChangePin,
  }
}

/** Session wajib ada. Untuk route yang memang butuh login. */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) throw new UnauthenticatedError()
  return session
}

/**
 * Session wajib ada DAN rolenya cocok.
 *
 * Otorisasi ditegakkan di server. Menyembunyikan tombol di frontend bukan
 * otorisasi — route ini menolak sebelum logika apa pun berjalan.
 */
export async function requireRole(...allowed: Role[]): Promise<SessionUser> {
  const session = await requireSession()
  if (!allowed.includes(session.role)) {
    throw new ForbiddenError('Akses ini hanya untuk pemilik')
  }
  return session
}

export async function destroySession(): Promise<void> {
  const store = await cookies()
  const token = store.get(config.auth.sessionCookieName)?.value
  if (token) {
    await prisma.session
      .delete({ where: { id: hashSessionToken(token) } })
      .catch(() => undefined)
  }
  store.delete(config.auth.sessionCookieName)
}

/** Bersihkan session kedaluwarsa. Dipanggil saat startup. */
export async function pruneExpiredSessions(now: Date): Promise<number> {
  const res = await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } })
  return res.count
}
