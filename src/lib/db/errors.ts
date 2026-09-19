/**
 * Pengenalan error Prisma tanpa mengimpor runtime Prisma.
 *
 * `Prisma.PrismaClientKnownRequestError` hanya tersedia lewat impor runtime,
 * dan modul yang dipakai startup harus sehemat mungkin dalam menarik dependensi
 * (docs/architecture.md §10.1). Kodenya sendiri stabil dan terdokumentasi, jadi
 * memeriksa bentuk objeknya sudah cukup.
 */

function errorCode(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** P2002: pelanggaran unique constraint. */
export function isUniqueViolation(e: unknown): boolean {
  return errorCode(e) === 'P2002'
}
