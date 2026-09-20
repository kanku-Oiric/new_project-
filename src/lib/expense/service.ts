import 'server-only'
import type { Expense } from '@prisma/client'
import { recordAudit, type AuditActor } from '../audit'
import { config } from '../config'
import { isUniqueViolation } from '../db/errors'
import { prisma } from '../db/prisma'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { ExpenseSourceSchema } from '../enums'
import { fingerprint } from '../idempotency-server'
import { toBusinessDate } from '../time'

/**
 * Pengeluaran kas.
 *
 * Referensi: docs/database.md (model Expense), docs/reporting.md §4
 *
 * Hanya `paidFrom = CASH_DRAWER` yang mengurangi expected cash. Pengeluaran
 * yang dibayar lewat transfer atau uang pribadi pemilik tetap masuk laporan
 * tapi tidak menyentuh laci.
 */

export interface ExpenseActor extends AuditActor {
  userId: string
}

export interface CreateExpenseInput {
  shiftId: string
  kategori: string
  amount: number
  note?: string
  paidFrom: string
  /**
   * Kunci sekali-pakai (src/lib/idempotency.ts). WAJIB.
   *
   * Pengeluaran yang tercatat dua kali tidak terlihat seperti bug: expected cash
   * shift itu turun dua kali, laci tampak kurang, dan yang dicurigai adalah
   * kasirnya. Karena itu penjagaannya tidak boleh bergantung pada client.
   */
  idempotencyKey: string
}

export interface CreateExpenseResult {
  expense: Expense
  /** `true` = pengeluaran ini sudah tersimpan sebelumnya; tidak ada uang kedua yang keluar. */
  replayed: boolean
}

/**
 * Sidik jari isi pengeluaran.
 *
 * Shift TIDAK ikut, sejalan dengan refund: kalau response hilang lalu shift
 * ditutup dan dibuka lagi, pengeluarannya sudah membebani laci yang lama dan
 * harus tetap di sana.
 *
 * Yang disidik jari adalah bentuk TERSIMPANnya (sudah di-trim dan di-parse),
 * bukan bentuk mentahnya, supaya dua request yang tersimpan identik tidak
 * menghasilkan dua sidik jari berbeda hanya karena spasi di ujung.
 */
function expenseFingerprint(input: {
  kategori: string
  amount: number
  note?: string
  paidFrom: string
}): string {
  return fingerprint({
    kategori: input.kategori.trim(),
    amount: input.amount,
    note: input.note?.trim() || null,
    paidFrom: input.paidFrom,
  })
}

/**
 * Baca pengeluaran yang kuncinya sudah pernah dipakai. `null` = belum pernah.
 *
 * Baris yang sudah di-soft-delete tetap dijawab apa adanya: request-nya memang
 * pernah berlaku, dan penghapusannya peristiwa terpisah yang punya jejaknya
 * sendiri. Menjawab "belum ada" justru akan membuat pengulangan mencatat
 * pengeluaran kedua atas uang yang sama.
 */
async function readExpenseByKey(
  key: string,
  expectedFingerprint: string,
  actorUserId: string,
): Promise<CreateExpenseResult | null> {
  const expense = await prisma.expense.findUnique({ where: { idempotencyKey: key } })
  if (!expense) return null

  if (expense.idempotencyFingerprint !== expectedFingerprint) {
    throw new ConflictError(
      'Kunci ini sudah dipakai untuk pengeluaran yang berbeda. Muat ulang halaman pengeluaran sebelum mengulang.',
    )
  }
  // Sejajar dengan checkout dan refund: kunci milik orang lain tidak dijawab
  // dengan data, supaya kunci yang tertebak tidak membocorkan pengeluaran kasir
  // lain kepada siapa pun di LAN.
  if (expense.createdByUserId !== actorUserId) {
    throw new ConflictError('Kunci pengeluaran ini milik kasir lain.')
  }

  return { expense, replayed: true }
}

export async function createExpense(
  actor: ExpenseActor,
  input: CreateExpenseInput,
  now: Date = new Date(),
): Promise<CreateExpenseResult> {
  const paidFrom = ExpenseSourceSchema.parse(input.paidFrom)

  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new ValidationError('Nominal pengeluaran harus bilangan bulat rupiah, minimal 1')
  }

  // Lapis kedua setelah Zod di route. Di sinilah uang benar-benar keluar dari
  // laci, jadi invariannya tidak boleh bergantung pada satu route saja.
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
    throw new ValidationError('idempotencyKey wajib diisi untuk mencatat pengeluaran')
  }
  const print = expenseFingerprint({ ...input, paidFrom })

  // Jalur cepat: pengulangan tidak menyentuh logika pencatatan sama sekali.
  const sudahAda = await readExpenseByKey(input.idempotencyKey, print, actor.userId)
  if (sudahAda) return sudahAda

  const shift = await prisma.shift.findUnique({ where: { id: input.shiftId } })
  if (!shift) throw new NotFoundError('Shift tidak ditemukan')
  if (shift.status !== 'OPEN') {
    throw new ConflictError('Pengeluaran hanya bisa dicatat pada shift yang terbuka')
  }

  try {
    const expense = await prisma.expense.create({
      data: {
        shiftId: input.shiftId,
        businessDate: toBusinessDate(now, config.timezone),
        kategori: input.kategori.trim(),
        amount: input.amount,
        note: input.note?.trim() || null,
        paidFrom,
        createdByUserId: actor.userId,
        createdAt: now,
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: print,
      },
    })
    return { expense, replayed: false }
  } catch (e) {
    // Dua request serentak dengan kunci yang sama: keduanya lolos jalur cepat di
    // atas, lalu indeks unique di DATABASE yang menentukan pemenangnya. Yang
    // kalah membaca hasil pemenang, bukan menerima error.
    if (isUniqueViolation(e)) {
      const lagi = await readExpenseByKey(input.idempotencyKey, print, actor.userId)
      if (lagi) return lagi
    }
    throw e
  }
}

export async function listExpenses(shiftId: string) {
  return prisma.expense.findMany({
    where: { shiftId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Hapus pengeluaran — SOFT delete, dan hanya selama shiftnya masih terbuka.
 *
 * Barisnya tetap ada supaya jejaknya tidak hilang; ia dikecualikan dari semua
 * perhitungan lewat `deletedAt`. Setelah shift ditutup, kasnya sudah
 * direkonsiliasi dan angkanya permanen — koreksi harus lewat pengeluaran baru,
 * bukan menghapus yang lama.
 */
export async function deleteExpense(
  actor: ExpenseActor & { authorizedByUserId: string },
  expenseId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findUnique({
      where: { id: expenseId },
      include: { shift: true },
    })
    if (!expense) throw new NotFoundError('Pengeluaran tidak ditemukan')
    if (expense.deletedAt) throw new ConflictError('Pengeluaran sudah dihapus')
    if (expense.shift.status !== 'OPEN') {
      throw new ConflictError(
        'Shift sudah ditutup — pengeluaran tidak bisa dihapus. Catat koreksi sebagai pengeluaran baru.',
      )
    }

    await tx.expense.update({
      where: { id: expenseId },
      data: { deletedAt: now, deletedByUserId: actor.authorizedByUserId },
    })

    await recordAudit(tx, actor, {
      action: 'EXPENSE_DELETE',
      summary: `Pengeluaran ${expense.kategori} ${expense.amount} dihapus`,
      entityType: 'Expense',
      entityId: expenseId,
      before: { kategori: expense.kategori, amount: expense.amount, paidFrom: expense.paidFrom },
      after: { deletedAt: now, authorizedByUserId: actor.authorizedByUserId },
    })
  })
}
