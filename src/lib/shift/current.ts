import type { Prisma } from '@prisma/client'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { toBusinessDate } from '../time'

/**
 * Shift yang sedang terbuka untuk seorang kasir.
 *
 * SCAFFOLDING FASE 2 — akan diganti di Fase 3.
 *
 * `transactions.shiftId` adalah kolom wajib, jadi checkout tidak bisa jalan
 * tanpa shift. Sementara layar buka/tutup shift belum ada (Fase 3), fungsi
 * `ensureOpenShift` membuka shift dengan kas awal nol secara otomatis supaya
 * Fase 2 bisa dijalankan dan diuji utuh.
 *
 * Yang HARUS berubah di Fase 3:
 *  - `ensureOpenShift` dihapus; kasir membuka shift sendiri dengan kas awal.
 *  - Checkout tanpa shift OPEN ditolak, bukan dibuatkan diam-diam.
 * Sampai itu terjadi, rekonsiliasi kas belum berarti apa-apa karena kas awal
 * selalu nol.
 */

export async function findOpenShift(
  cashierId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return db.shift.findFirst({
    where: { cashierId, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  })
}

/**
 * Kembalikan shift OPEN milik kasir, buka satu kalau belum ada.
 *
 * Race dua device yang checkout bersamaan pada kasir yang sama ditangani oleh
 * `openKey @unique`: pembuatan kedua ditolak database, lalu kita ambil shift
 * yang sudah ada. Tanpa penanganan ini, checkout pertama di pagi hari bisa
 * gagal hanya karena dua tab dibuka bersamaan.
 */
export async function ensureOpenShift(cashierId: string, now: Date = new Date()): Promise<string> {
  const existing = await findOpenShift(cashierId)
  if (existing) return existing.id

  try {
    const created = await prisma.shift.create({
      data: {
        cashierId,
        status: 'OPEN',
        openKey: cashierId,
        openedAt: now,
        openingCash: 0,
        businessDate: toBusinessDate(now, config.timezone),
        notes: 'Dibuka otomatis oleh Fase 2 (layar shift belum ada)',
      },
    })
    return created.id
  } catch {
    // openKey unik menolak shift OPEN kedua. Artinya device lain menang balapan
    // dan shiftnya sudah ada — ambil itu.
    const raced = await findOpenShift(cashierId)
    if (raced) return raced.id
    throw new Error('gagal membuka shift dan tidak menemukan shift yang terbuka')
  }
}
