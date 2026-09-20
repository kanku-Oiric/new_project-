import 'server-only'
import type { Prisma } from '@prisma/client'
import { recordAudit, type AuditActor } from '../audit'
import { runBackup } from '../backup'
import { canTransition } from '../payment'
import { AUTO_CANCEL_REASON } from '../transaction/void-rules'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { createLogger } from '../logger'
import { toBusinessDate } from '../time'
import { buildShiftSummary, type ShiftSummary } from './index'

const log = createLogger('shift')

/**
 * Buka/tutup shift dan rekonsiliasi kas.
 *
 * Referensi: docs/architecture.md §9.1, docs/reporting.md §4
 */

export interface ShiftActor extends AuditActor {
  userId: string
}

/** Kumpulkan angka kas satu shift dari baris mentah. Matematikanya di modul murni. */
async function gatherSummary(
  db: Prisma.TransactionClient,
  shiftId: string,
  countedCash: number | null,
): Promise<ShiftSummary> {
  const shift = await db.shift.findUnique({ where: { id: shiftId } })
  if (!shift) throw new NotFoundError('Shift tidak ditemukan')

  const [
    cashPaid,
    nonCashPaid,
    cashOutPaid,
    refunds,
    expenses,
    topups,
    completedCount,
    pendingCount,
  ] = await Promise.all([
    db.payment.aggregate({
      _sum: { amount: true },
      where: {
        method: 'CASH',
        status: 'PAID',
        transaction: { shiftId, status: 'COMPLETED' },
      },
    }),
    db.payment.aggregate({
      _sum: { amount: true },
      where: {
        // `notIn`, bukan `not: 'CASH'`. Sejak ada CASH_OUT, "bukan tunai"
        // tidak lagi sama dengan "bukan uang kertas": serah tunai adalah uang
        // kertas yang KELUAR, dan menghitungnya sebagai penjualan non-tunai
        // akan menaikkan angka QRIS sebesar uang yang justru baru saja keluar.
        method: { notIn: ['CASH', 'CASH_OUT'] },
        status: 'PAID',
        transaction: { shiftId, status: 'COMPLETED' },
      },
    }),
    db.payment.aggregate({
      _sum: { amount: true },
      where: {
        method: 'CASH_OUT',
        status: 'PAID',
        transaction: { shiftId, status: 'COMPLETED' },
      },
    }),
    db.refund.aggregate({ _sum: { amount: true }, where: { shiftId, method: 'CASH' } }),
    db.expense.aggregate({
      _sum: { amount: true },
      where: { shiftId, paidFrom: 'CASH_DRAWER', deletedAt: null },
    }),
    db.providerBalanceMovement.aggregate({
      _sum: { amountChange: true },
      where: { shiftId, reason: 'TOPUP', paidFrom: 'CASH_DRAWER' },
    }),
    db.transaction.count({ where: { shiftId, status: 'COMPLETED' } }),
    db.transaction.count({ where: { shiftId, status: 'PENDING' } }),
  ])

  return buildShiftSummary({
    openingCash: shift.openingCash,
    // Transaksi VOIDED dikecualikan lewat `status: 'COMPLETED'` di query —
    // secara ekonomi ia tidak pernah terjadi.
    cashSales: cashPaid._sum.amount ?? 0,
    cashRefunds: refunds._sum.amount ?? 0,
    cashExpenses: expenses._sum.amount ?? 0,
    // amountChange top-up selalu positif (saldo bertambah); yang dikurangkan
    // dari laci adalah nominal yang sama.
    cashProviderTopups: topups._sum.amountChange ?? 0,
    cashServicePayouts: cashOutPaid._sum.amount ?? 0,
    nonCashSales: nonCashPaid._sum.amount ?? 0,
    transactionCount: completedCount,
    pendingCount,
    countedCash,
  })
}

export async function getShiftSummary(shiftId: string): Promise<ShiftSummary> {
  return prisma.$transaction((tx) => gatherSummary(tx, shiftId, null))
}

export async function findOpenShift(cashierId: string) {
  return prisma.shift.findFirst({
    where: { cashierId, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  })
}

/**
 * Buka shift.
 *
 * Satu shift OPEN per kasir ditegakkan `openKey @unique` di database, bukan
 * hanya dicek di kode: dua device yang menekan "Buka shift" bersamaan tidak
 * boleh lolos keduanya.
 */
export async function openShift(
  actor: ShiftActor,
  openingCash: number,
  now: Date = new Date(),
): Promise<{ shiftId: string }> {
  if (!Number.isInteger(openingCash) || openingCash < 0) {
    throw new ValidationError('Kas awal harus bilangan bulat rupiah, minimal 0')
  }

  const existing = await findOpenShift(actor.userId)
  if (existing) {
    throw new ConflictError('Kamu sudah punya shift yang terbuka. Tutup dulu sebelum membuka baru.')
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const shift = await tx.shift.create({
        data: {
          cashierId: actor.userId,
          status: 'OPEN',
          openKey: actor.userId,
          openedAt: now,
          openingCash,
          businessDate: toBusinessDate(now, config.timezone),
        },
      })

      await recordAudit(tx, actor, {
        action: 'SHIFT_OPEN',
        summary: `Shift dibuka dengan kas awal ${openingCash}`,
        entityType: 'Shift',
        entityId: shift.id,
        after: { openingCash },
      })

      return { shiftId: shift.id }
    })
  } catch (e) {
    // openKey unik menolak shift OPEN kedua.
    const raced = await findOpenShift(actor.userId)
    if (raced) {
      throw new ConflictError('Shift sudah dibuka dari perangkat lain')
    }
    throw e
  }
}

export interface CloseShiftResult {
  summary: ShiftSummary
  cancelledPending: number
  backupFile: string | null
}

/**
 * Tutup shift.
 *
 * Transaksi PENDING milik shift ini otomatis dibatalkan, dan penutupan TIDAK
 * PERNAH diblokir karenanya. Kasir tidak boleh terjebak di akhir shift oleh
 * transaksi QRIS terlantar yang bukan salahnya — memaksanya membersihkan satu
 * per satu berujung pada shift yang tidak ditutup sama sekali, yang jauh lebih
 * buruk bagi rekonsiliasi kas.
 *
 * Aman tanpa efek samping karena transaksi PENDING belum pernah menyentuh stok
 * dan pembayarannya belum pernah PAID (docs/qris.md §3.1).
 */
export async function closeShift(
  actor: ShiftActor,
  shiftId: string,
  countedCash: number,
  notes: string | null,
  now: Date = new Date(),
): Promise<CloseShiftResult> {
  if (!Number.isInteger(countedCash) || countedCash < 0) {
    throw new ValidationError('Uang yang dihitung harus bilangan bulat rupiah, minimal 0')
  }

  const result = await prisma.$transaction(async (tx) => {
    const shift = await tx.shift.findUnique({ where: { id: shiftId } })
    if (!shift) throw new NotFoundError('Shift tidak ditemukan')
    if (shift.status !== 'OPEN') {
      throw new ConflictError('Shift sudah ditutup. Data shift tertutup tidak bisa diubah.')
    }
    if (shift.cashierId !== actor.userId && actor.role !== 'OWNER') {
      throw new ConflictError('Hanya kasir pemilik shift atau pemilik toko yang bisa menutupnya')
    }

    // Batalkan transaksi terlantar sebelum menghitung, supaya angkanya final.
    const pending = await tx.transaction.findMany({
      where: { shiftId, status: 'PENDING' },
      select: { id: true, trxNumber: true },
    })

    for (const t of pending) {
      // Lewat state machine resmi, sama seperti void. Filter `status: 'PENDING'`
      // di bawah sudah benar sejak awal, tapi keabsahan transisinya kini
      // DINYATAKAN, bukan tersirat dari bentuk query — supaya satu-satunya
      // tempat yang mendefinisikan transisi sah tetap `canTransition`.
      if (!canTransition('PENDING', 'CANCELLED')) {
        throw new ConflictError('Transisi PENDING → CANCELLED ditolak state machine')
      }
      await tx.payment.updateMany({
        where: { transactionId: t.id, status: 'PENDING' },
        data: { status: 'CANCELLED', failureReason: AUTO_CANCEL_REASON },
      })
      await tx.transaction.update({
        where: { id: t.id },
        data: { status: 'CANCELLED', cancelReason: AUTO_CANCEL_REASON },
      })
    }

    if (pending.length > 0) {
      await recordAudit(tx, actor, {
        action: 'PENDING_CANCELLED_ON_SHIFT_CLOSE',
        summary: `${pending.length} transaksi belum selesai dibatalkan saat tutup shift`,
        entityType: 'Shift',
        entityId: shiftId,
        after: { trxNumbers: pending.map((t) => t.trxNumber) },
      })
    }

    const summary = await gatherSummary(tx, shiftId, countedCash)

    await tx.shift.update({
      where: { id: shiftId },
      data: {
        status: 'CLOSED',
        // openKey null membebaskan kasir membuka shift berikutnya, sekaligus
        // membuat baris CLOSED tidak pernah bertabrakan di kolom unique.
        openKey: null,
        closedAt: now,
        closedByUserId: actor.userId,
        countedCash,
        expectedCash: summary.expectedCash,
        difference: summary.difference,
        notes,
      },
    })

    await recordAudit(tx, actor, {
      action: 'SHIFT_CLOSE',
      summary: `Shift ditutup. Expected ${summary.expectedCash}, dihitung ${countedCash}, selisih ${summary.difference}`,
      entityType: 'Shift',
      entityId: shiftId,
      after: {
        expectedCash: summary.expectedCash,
        countedCash,
        difference: summary.difference,
        cancelledPending: pending.length,
      },
    })

    return { summary, cancelledPending: pending.length }
  })

  // Backup SETELAH commit, bukan di dalam transaction: VACUUM INTO membaca
  // database, dan menjalankannya di tengah transaction tulis akan mengunci diri
  // sendiri. Kegagalannya juga tidak boleh membatalkan penutupan shift.
  let backupFile: string | null = null
  try {
    const backup = await runBackup(now)
    backupFile = backup.file
  } catch (e) {
    log.error('backup setelah tutup shift gagal — shift tetap tertutup', e)
  }

  return { ...result, backupFile }
}
