import { prisma } from './prisma'

/**
 * Perawatan database yang dijalankan saat startup.
 *
 * Isinya sengaja hanya query Prisma polos, TANPA impor apa pun dari `auth/`.
 *
 * Alasannya struktural, bukan kosmetik. `instrumentation.ts` dikompilasi Next.js
 * untuk dua runtime sekaligus, dan webpack tetap menelusuri seluruh graph impor
 * walaupun pemanggilannya dijaga `process.env.NEXT_RUNTIME`. Guard itu mencegah
 * EKSEKUSI, bukan BUNDLING. Sebelumnya `startup.ts` mengimpor
 * `pruneExpiredSessions` dari `auth/session`, yang menarik `auth/pin`, yang
 * menarik `bcryptjs` dan `node:crypto` — dan keduanya tidak ada di runtime
 * non-Node. Akibatnya seluruh module graph dev server gagal dibangun dan SEMUA
 * route mengembalikan 500, bukan cuma yang memakai startup.
 *
 * Jadi aturannya: apa pun yang bisa dijangkau dari `instrumentation.ts` harus
 * bebas dari kriptografi dan dependensi Node yang tidak bisa di-resolve di
 * runtime lain.
 */

/** Hapus session yang sudah kedaluwarsa. */
export async function pruneExpiredSessions(now: Date): Promise<number> {
  const res = await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } })
  return res.count
}

/** Cek koneksi database untuk /api/health dan dashboard. */
export async function checkDatabase(): Promise<{ ok: boolean; error: string | null }> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    return { ok: true, error: null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
