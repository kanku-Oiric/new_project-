import 'server-only'
import { recordAudit, type AuditActor } from '../audit'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { applyStockMovement } from '../db/stock'
import { nextNumber } from '../db/counter'
import { isUniqueViolation } from '../db/errors'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { canonicalJson } from '../idempotency'
import { fingerprint } from '../idempotency-server'
import {
  computeRefund,
  type RefundableItem,
  type RefundLineInput,
} from '../refund'
import { RefundMethodSchema, type PaymentMethod, type PaymentStatus, type RefundMethod, type ShiftStatus, type TransactionStatus } from '../enums'
import { toBusinessDate } from '../time'
import { canTransition } from '../payment'
import { checkVoidEligibility, voidNeedsManualRefund } from './void-rules'

/**
 * Void dan refund.
 *
 * Referensi: docs/architecture.md §9.2–9.3
 *
 * Keduanya butuh PIN pemilik, yang diverifikasi di route sebelum memanggil
 * fungsi di sini — `authorizedByUserId` diteruskan sebagai bukti otorisasi.
 */

export interface PrivilegedActor extends AuditActor {
  userId: string
  /** Pemilik yang PIN-nya diverifikasi server. */
  authorizedByUserId: string
}

// ─────────────────────────────── Kelayakan ───────────────────────────────

export interface TransactionVoidInfo {
  canVoid: boolean
  voidBlockedReason: string | null
  needsManualRefund: boolean
}

export async function getVoidInfo(
  transactionId: string,
  now: Date = new Date(),
): Promise<TransactionVoidInfo> {
  const trx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: {
      shift: true,
      payments: true,
      refunds: { select: { id: true } },
      services: { select: { id: true } },
    },
  })
  if (!trx) throw new NotFoundError('Transaksi tidak ditemukan')

  const eligibility = checkVoidEligibility({
    status: trx.status as TransactionStatus,
    businessDate: trx.businessDate,
    shiftStatus: trx.shift.status as ShiftStatus,
    hasRefund: trx.refunds.length > 0,
    hasService: trx.services.length > 0,
    today: toBusinessDate(now, config.timezone),
  })

  const paid = trx.payments.find((p) => p.status === 'PAID')

  return {
    canVoid: eligibility.canVoid,
    voidBlockedReason: eligibility.reason,
    needsManualRefund: paid
      ? voidNeedsManualRefund(paid.method as PaymentMethod, paid.status as PaymentStatus)
      : false,
  }
}

// ─────────────────────────────── Void ───────────────────────────────

export interface VoidResult {
  trxNumber: string
  needsManualRefund: boolean
  restoredItems: { productName: string; qty: number }[]
}

/**
 * Batalkan transaksi utuh: stok kembali, pembayaran CANCELLED, transaksi VOIDED.
 *
 * Seluruhnya dalam satu DB transaction. Syarat kelayakan dicek ULANG di sini,
 * bukan cuma di UI — dua kasir bisa saja membuka layar yang sama sebelum salah
 * satunya menutup shift.
 */
export async function voidTransaction(
  actor: PrivilegedActor,
  transactionId: string,
  reason: string,
  now: Date = new Date(),
): Promise<VoidResult> {
  return prisma.$transaction(async (tx) => {
    const trx = await tx.transaction.findUnique({
      where: { id: transactionId },
      include: {
        items: true,
        payments: true,
        shift: true,
        refunds: { select: { id: true } },
        services: { select: { id: true } },
      },
    })
    if (!trx) throw new NotFoundError('Transaksi tidak ditemukan')

    const eligibility = checkVoidEligibility({
      status: trx.status as TransactionStatus,
      businessDate: trx.businessDate,
      shiftStatus: trx.shift.status as ShiftStatus,
      hasRefund: trx.refunds.length > 0,
      hasService: trx.services.length > 0,
      today: toBusinessDate(now, config.timezone),
    })
    if (!eligibility.canVoid) {
      throw new ConflictError(eligibility.reason ?? 'Transaksi tidak bisa dibatalkan')
    }

    const paid = trx.payments.find((p) => p.status === 'PAID')
    const needsManualRefund = paid
      ? voidNeedsManualRefund(paid.method as PaymentMethod, paid.status as PaymentStatus)
      : false

    const businessDate = toBusinessDate(now, config.timezone)
    const restoredItems: VoidResult['restoredItems'] = []

    for (const item of trx.items) {
      await applyStockMovement(tx, {
        productId: item.productId,
        qtyChange: item.qty,
        reason: 'VOID',
        refType: 'TRANSACTION',
        refId: trx.id,
        userId: actor.userId,
        businessDate,
        note: `Void ${trx.trxNumber}`,
      })
      restoredItems.push({ productName: item.productName, qty: item.qty })
    }

    // Pembatalan pembayaran lewat STATE MACHINE RESMI, bukan penimpaan langsung.
    //
    // Dulu baris ini `updateMany({ where: { transactionId } })` tanpa filter
    // status: ia menimpa SEMUA pembayaran menjadi CANCELLED, termasuk yang sudah
    // PAID, tanpa pernah menanyakan apakah transisi itu sah. Akibatnya invarian
    // "state terminal tidak punya transisi keluar" ditegakkan `canTransition`
    // untuk semua jalur KECUALI jalur yang benar-benar melanggarnya.
    //
    // Sekarang: `canTransition(..., 'VOID')` yang memutuskan baris mana boleh
    // berubah, lalu guarded update memastikan statusnya belum bergeser di
    // perangkat lain — pola dua lapis yang sama dengan pelunasan (§9.1).
    for (const p of trx.payments) {
      const dari = p.status as PaymentStatus
      if (!canTransition(dari, 'CANCELLED', 'VOID')) {
        // Sudah CANCELLED, EXPIRED, atau FAILED. Dibiarkan apa adanya: void
        // tidak boleh menulis ulang sejarah pembayaran yang sudah selesai
        // dengan cara lain.
        continue
      }

      const updated = await tx.payment.updateMany({
        where: { id: p.id, status: dari },
        data: { status: 'CANCELLED', failureReason: `Void: ${reason}` },
      })
      if (updated.count !== 1) {
        throw new ConflictError('Pembayaran berubah di perangkat lain saat void diproses')
      }
    }

    await tx.transaction.update({
      where: { id: trx.id },
      data: {
        status: 'VOIDED',
        voidedAt: now,
        voidedByUserId: actor.authorizedByUserId,
        voidReason: reason,
      },
    })

    await recordAudit(tx, actor, {
      action: 'VOID',
      summary: `${trx.trxNumber} dibatalkan (${trx.netTotal}) — ${reason}`,
      entityType: 'Transaction',
      entityId: trx.id,
      before: { status: trx.status, netTotal: trx.netTotal },
      after: {
        status: 'VOIDED',
        reason,
        authorizedByUserId: actor.authorizedByUserId,
        paymentMethod: paid?.method ?? null,
        // Kewajiban pengembalian uang manual dilacak di sini, bukan bergantung
        // pada ingatan orang yang menekan tombol.
        manualRefundRequired: needsManualRefund,
      },
    })

    return { trxNumber: trx.trxNumber, needsManualRefund, restoredItems }
  })
}

// ─────────────────────────────── Refund ───────────────────────────────

export interface RefundResult {
  refundId: string
  refundNumber: string
  amount: number
  cogsAmount: number
  /**
   * `true` berarti refund ini sudah pernah tersimpan dan request ini tidak
   * mengeluarkan uang kedua. Lihat src/lib/idempotency.ts.
   */
  replayed: boolean
}

/**
 * Sidik jari isi refund.
 *
 * Transaksi asal ikut, karena kunci yang sama untuk transaksi lain adalah bug,
 * bukan pengulangan. Shift TIDAK ikut: kalau response hilang lalu shift berganti,
 * refundnya sudah membebani laci yang lama dan harus tetap di sana.
 */
function refundFingerprint(
  transactionId: string,
  requested: RefundLineInput[],
  method: string,
  reason: string,
): string {
  return fingerprint({
    transactionId,
    items: requested
      .map((r) => canonicalJson({ transactionItemId: r.transactionItemId, qty: r.qty }))
      .sort(),
    method,
    reason,
  })
}

/**
 * Baca refund yang kuncinya sudah pernah dipakai. `null` = belum pernah.
 *
 * Penolakan di sini sama alasannya dengan di checkout: kunci yang sama dengan isi
 * berbeda tidak boleh dijawab dengan data refund lain, karena kasir akan mengira
 * uang yang keluar adalah yang baru saja ia maksud.
 */
async function readRefundByKey(
  key: string,
  expectedFingerprint: string,
  actorUserId: string,
): Promise<RefundResult | null> {
  const refund = await prisma.refund.findUnique({ where: { idempotencyKey: key } })
  if (!refund) return null

  if (refund.idempotencyFingerprint !== expectedFingerprint) {
    throw new ConflictError(
      'Kunci refund ini sudah dipakai untuk refund yang berbeda. Muat ulang halaman transaksi sebelum mengulang.',
    )
  }
  // Sejajar dengan checkout: kunci milik orang lain tidak dijawab dengan data.
  // Tanpa ini, kunci yang tertebak mengembalikan nomor dan nominal refund kasir
  // lain kepada siapa pun yang memegang PIN pemilik.
  if (refund.createdByUserId !== actorUserId) {
    throw new ConflictError('Kunci refund ini milik kasir lain.')
  }

  return {
    refundId: refund.id,
    refundNumber: refund.refundNumber,
    amount: refund.amount,
    cogsAmount: refund.cogsAmount,
    replayed: true,
  }
}

/**
 * Refund sebagian atau seluruh item.
 *
 * Dibebankan ke shift tempat REFUND terjadi, bukan shift penjualan asal —
 * kalau tidak, uang keluar akan membebani laci yang sudah ditutup dan
 * direkonsiliasi.
 */
export async function createRefund(
  actor: PrivilegedActor,
  transactionId: string,
  shiftId: string,
  requested: RefundLineInput[],
  method: string,
  reason: string,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<RefundResult> {
  // Lapis kedua setelah Zod di route. Service ini adalah batas tempat uang
  // benar-benar keluar, jadi invariannya tidak boleh bergantung pada satu route.
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new ValidationError('idempotencyKey wajib diisi untuk membuat refund')
  }

  const refundMethod = RefundMethodSchema.parse(method)
  const print = refundFingerprint(transactionId, requested, refundMethod, reason)

  const replayed = await readRefundByKey(idempotencyKey, print, actor.userId)
  if (replayed) return replayed

  try {
    return await refundInTransaction({
      actor,
      transactionId,
      shiftId,
      requested,
      refundMethod,
      reason,
      idempotencyKey,
      print,
      now,
    })
  } catch (e) {
    // Sama seperti checkout: indeks unique di DB yang memutuskan pemenang saat
    // dua request serentak membawa kunci yang sama.
    if (isUniqueViolation(e)) {
      const replayed = await readRefundByKey(idempotencyKey, print, actor.userId)
      if (replayed) return replayed
    }
    throw e
  }
}

/**
 * Satu objek, bukan sembilan parameter berjejer: di antaranya ada empat `string`
 * berturut-turut, dan TypeScript tidak akan menangkap kalau dua di antaranya
 * tertukar.
 */
interface RefundExecution {
  actor: PrivilegedActor
  transactionId: string
  shiftId: string
  requested: RefundLineInput[]
  refundMethod: RefundMethod
  reason: string
  idempotencyKey: string
  print: string
  now: Date
}

async function refundInTransaction(exec: RefundExecution): Promise<RefundResult> {
  const { actor, transactionId, shiftId, requested, refundMethod, reason, idempotencyKey, print, now } =
    exec

  return prisma.$transaction(async (tx) => {
    const trx = await tx.transaction.findUnique({
      where: { id: transactionId },
      include: { items: true },
    })
    if (!trx) throw new NotFoundError('Transaksi tidak ditemukan')
    if (trx.status === 'VOIDED' || trx.status === 'CANCELLED') {
      throw new ConflictError('Transaksi sudah dibatalkan, tidak bisa di-refund')
    }
    if (trx.status !== 'COMPLETED') {
      throw new ConflictError('Hanya transaksi yang sudah lunas yang bisa di-refund')
    }

    const shift = await tx.shift.findUnique({ where: { id: shiftId } })
    if (!shift) throw new NotFoundError('Shift tidak ditemukan')
    if (shift.status !== 'OPEN') {
      throw new ConflictError('Refund harus dilakukan pada shift yang terbuka')
    }

    const refundable: RefundableItem[] = trx.items.map((i) => ({
      transactionItemId: i.id,
      productName: i.productName,
      unitCost: i.unitCost,
      qty: i.qty,
      lineFinal: i.lineFinal,
      refundedQty: i.refundedQty,
      refundedAmount: i.refundedAmount,
    }))

    // Seluruh matematikanya di modul murni, termasuk guard refund berlebih.
    const totals = computeRefund(refundable, requested)

    const businessDate = toBusinessDate(now, config.timezone)
    const refundNumber = await nextNumber(tx, 'RFN', businessDate)

    const refund = await tx.refund.create({
      data: {
        refundNumber,
        transactionId: trx.id,
        shiftId,
        businessDate,
        amount: totals.amount,
        cogsAmount: totals.cogsAmount,
        method: refundMethod,
        reason,
        authorizedByUserId: actor.authorizedByUserId,
        createdByUserId: actor.userId,
        idempotencyKey,
        idempotencyFingerprint: print,
        items: {
          create: totals.lines.map((l) => ({
            transactionItemId: l.transactionItemId,
            qty: l.qty,
            amount: l.amount,
            cogsAmount: l.cogsAmount,
          })),
        },
      },
    })

    for (const line of totals.lines) {
      const item = trx.items.find((i) => i.id === line.transactionItemId)
      if (!item) throw new ConflictError('Item transaksi hilang saat refund')

      // Akumulatif diperbarui supaya rumus teleskopik pada refund berikutnya
      // berangkat dari angka yang benar.
      await tx.transactionItem.update({
        where: { id: item.id },
        data: {
          refundedQty: item.refundedQty + line.qty,
          refundedAmount: item.refundedAmount + line.amount,
        },
      })

      await applyStockMovement(tx, {
        productId: item.productId,
        qtyChange: line.qty,
        reason: 'REFUND',
        refType: 'REFUND',
        refId: refund.id,
        userId: actor.userId,
        businessDate,
        note: `Refund ${refundNumber}`,
      })
    }

    await recordAudit(tx, actor, {
      action: 'REFUND',
      summary: `${refundNumber} atas ${trx.trxNumber}: ${totals.amount} (${refundMethod}) — ${reason}`,
      entityType: 'Refund',
      entityId: refund.id,
      after: {
        refundNumber,
        transactionNumber: trx.trxNumber,
        amount: totals.amount,
        method: refundMethod,
        authorizedByUserId: actor.authorizedByUserId,
        lines: totals.lines.map((l) => ({ productName: l.productName, qty: l.qty, amount: l.amount })),
      },
    })

    return {
      refundId: refund.id,
      refundNumber,
      amount: totals.amount,
      cogsAmount: totals.cogsAmount,
      replayed: false,
    }
  })
}
