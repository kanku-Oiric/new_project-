import 'server-only'
import { recordAudit, type AuditActor } from '../audit'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { ExpenseSourceSchema } from '../enums'
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

export async function createExpense(
  actor: ExpenseActor,
  input: { shiftId: string; kategori: string; amount: number; note?: string; paidFrom: string },
  now: Date = new Date(),
) {
  const paidFrom = ExpenseSourceSchema.parse(input.paidFrom)

  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new ValidationError('Nominal pengeluaran harus bilangan bulat rupiah, minimal 1')
  }

  const shift = await prisma.shift.findUnique({ where: { id: input.shiftId } })
  if (!shift) throw new NotFoundError('Shift tidak ditemukan')
  if (shift.status !== 'OPEN') {
    throw new ConflictError('Pengeluaran hanya bisa dicatat pada shift yang terbuka')
  }

  return prisma.expense.create({
    data: {
      shiftId: input.shiftId,
      businessDate: toBusinessDate(now, config.timezone),
      kategori: input.kategori.trim(),
      amount: input.amount,
      note: input.note?.trim() || null,
      paidFrom,
      createdByUserId: actor.userId,
      createdAt: now,
    },
  })
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
