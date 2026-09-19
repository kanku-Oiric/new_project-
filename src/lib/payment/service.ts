import type { Prisma } from '@prisma/client'
import { recordAudit, type AuditActor, type Db } from '../audit'
import {
  settleTransactionInTx,
  type NegativeStockWarning,
  type SettleActor,
} from '../checkout'
import { prisma } from '../db/prisma'
import {
  PaymentMethodSchema,
  PaymentStatusSchema,
  TransactionStatusSchema,
  type PaymentMethod,
  type PaymentStatus,
  type TransactionStatus,
} from '../enums'
import { AppError, ConflictError, NotFoundError } from '../errors'
import { canTransition } from './index'
import { providerForMethod } from './registry'

/**
 * Konfirmasi dan pembatalan pembayaran.
 *
 * Referensi: docs/qris.md §3 dan §4
 *
 * Aturan yang ditegakkan file ini:
 *  - Satu-satunya jalan menuju PAID adalah `confirmPayment`, yang hanya bisa
 *    dipanggil oleh request HTTP dengan session terautentikasi. Tidak ada timer,
 *    tidak ada polling yang melunaskan, tidak ada mock yang sukses sendiri.
 *  - Pengurangan stok tetap milik `settleTransactionInTx` — jalur yang SAMA
 *    PERSIS dengan tunai. File ini tidak menyentuh stok sama sekali.
 *  - Dua lapis gerbang: `canTransition` atas status tersimpan, lalu guarded
 *    update di database.
 */

export interface PaymentActor extends AuditActor {
  userId: string
}

function parseStatus(raw: string): PaymentStatus {
  const parsed = PaymentStatusSchema.safeParse(raw)
  if (!parsed.success) {
    // Nilai di luar enum berarti data rusak, bukan kesalahan pemakai. Berhenti
    // keras: menebak status pembayaran adalah menebak soal uang.
    throw new AppError('INTERNAL', 500, `Status pembayaran tidak dikenal di database: ${raw}`)
  }
  return parsed.data
}

function parseMethod(raw: string): PaymentMethod {
  const parsed = PaymentMethodSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('INTERNAL', 500, `Metode pembayaran tidak dikenal di database: ${raw}`)
  }
  return parsed.data
}

function parseTransactionStatus(raw: string): TransactionStatus {
  const parsed = TransactionStatusSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('INTERNAL', 500, `Status transaksi tidak dikenal di database: ${raw}`)
  }
  return parsed.data
}

/** Pesan yang menyebut keadaan sebenarnya, bukan "gagal" tanpa keterangan. */
function terminalMessage(status: PaymentStatus, action: 'konfirmasi' | 'pembatalan'): string {
  switch (status) {
    case 'PAID':
      return action === 'konfirmasi'
        ? 'Pembayaran ini sudah dikonfirmasi. Tidak diproses dua kali.'
        : 'Pembayaran ini sudah lunas dan tidak bisa dibatalkan. Gunakan void atau refund.'
    case 'CANCELLED':
      return 'Pembayaran ini sudah dibatalkan. Buat transaksi baru.'
    case 'EXPIRED':
      return 'Pembayaran ini sudah kedaluwarsa. Buat transaksi baru.'
    case 'FAILED':
      return 'Pembayaran ini ditandai gagal. Buat transaksi baru.'
    case 'PENDING':
      // Tidak terjangkau: PENDING selalu punya transisi keluar.
      return 'Pembayaran masih menunggu.'
  }
}

// ─────────────────────────────── Konfirmasi ───────────────────────────────

export interface ConfirmPaymentResult {
  paymentId: string
  transactionId: string
  trxNumber: string
  method: PaymentMethod
  amount: number
  negativeStock: NegativeStockWarning[]
}

/**
 * Tandai pembayaran lunas, lalu lunaskan transaksinya.
 *
 * Dipanggil HANYA karena manusia menekan "Pembayaran diterima" — `actor.userId`
 * berasal dari session, dan tersimpan sebagai `confirmedByUserId` di baris
 * pembayaran oleh `settleTransactionInTx`.
 */
export async function confirmPaymentInTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  actor: SettleActor,
  now: Date = new Date(),
): Promise<ConfirmPaymentResult> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    include: { transaction: { select: { id: true, trxNumber: true, status: true } } },
  })
  if (!payment) throw new NotFoundError('Pembayaran tidak ditemukan')

  const status = parseStatus(payment.status)

  // LAPIS 1 atas status tersimpan. Konfirmasi kedua berhenti di sini dengan
  // pesan yang menyebut keadaan sebenarnya.
  if (!canTransition(status, 'PAID')) {
    throw new ConflictError(terminalMessage(status, 'konfirmasi'))
  }

  // Provider yang kredensialnya belakangan dimatikan TIDAK memblokir konfirmasi:
  // uang pelanggan mungkin sudah masuk rekening, dan menolak mencatatnya hanya
  // memindahkan masalah ke buku catatan tangan.
  const settled = await settleTransactionInTx(tx, payment.transactionId, actor, now)

  return {
    paymentId: payment.id,
    transactionId: payment.transaction.id,
    trxNumber: payment.transaction.trxNumber,
    method: parseMethod(payment.method),
    amount: payment.amount,
    negativeStock: settled.negativeStock,
  }
}

export async function confirmPayment(
  paymentId: string,
  actor: SettleActor,
  now: Date = new Date(),
): Promise<ConfirmPaymentResult> {
  return prisma.$transaction((tx) => confirmPaymentInTx(tx, paymentId, actor, now))
}

// ─────────────────────────────── Pembatalan ───────────────────────────────

export interface CancelPaymentResult {
  paymentId: string
  transactionId: string
  trxNumber: string
  /** Transaksinya ikut dibatalkan (selalu true untuk QRIS yang belum lunas). */
  transactionCancelled: boolean
}

/**
 * Batalkan pembayaran yang masih menunggu.
 *
 * Tidak ada stok yang perlu dibalik: transaksi PENDING belum pernah menyentuh
 * stok (docs/qris.md §3.1). Itulah yang membuat pembatalan — baik oleh kasir
 * maupun otomatis saat tutup shift — aman tanpa efek samping.
 */
export async function cancelPaymentInTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  actor: PaymentActor,
  reason: string,
): Promise<CancelPaymentResult> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    include: { transaction: { select: { id: true, trxNumber: true, status: true } } },
  })
  if (!payment) throw new NotFoundError('Pembayaran tidak ditemukan')

  const status = parseStatus(payment.status)
  if (!canTransition(status, 'CANCELLED')) {
    throw new ConflictError(terminalMessage(status, 'pembatalan'))
  }

  const updated = await tx.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: { status: 'CANCELLED', failureReason: reason },
  })
  if (updated.count !== 1) {
    throw new ConflictError('Pembayaran sudah diproses di perangkat lain')
  }

  // Transaksi yang sudah COMPLETED tidak mungkin sampai ke sini (pembayarannya
  // PAID, dan PAID tidak punya transisi keluar), tapi syaratnya ditulis eksplisit
  // supaya tidak ada transaksi lunas yang berubah status karena satu barisnya
  // dibatalkan.
  const transactionStatus = parseTransactionStatus(payment.transaction.status)
  const transactionCancelled = transactionStatus === 'PENDING'
  if (transactionCancelled) {
    await tx.transaction.update({
      where: { id: payment.transaction.id },
      data: { status: 'CANCELLED', cancelReason: reason },
    })
  }

  await recordAudit(tx, actor, {
    action: 'PAYMENT_CANCEL',
    summary: `${payment.transaction.trxNumber} dibatalkan sebelum lunas — ${reason}`,
    entityType: 'Payment',
    entityId: payment.id,
    before: { status },
    after: {
      status: 'CANCELLED',
      trxNumber: payment.transaction.trxNumber,
      method: payment.method,
      amount: payment.amount,
      transactionCancelled,
    },
  })

  return {
    paymentId: payment.id,
    transactionId: payment.transaction.id,
    trxNumber: payment.transaction.trxNumber,
    transactionCancelled,
  }
}

export async function cancelPayment(
  paymentId: string,
  actor: PaymentActor,
  reason: string,
): Promise<CancelPaymentResult> {
  return prisma.$transaction((tx) => cancelPaymentInTx(tx, paymentId, actor, reason))
}

// ─────────────────────────────── Status ───────────────────────────────

export interface PaymentStatusView {
  paymentId: string
  method: PaymentMethod
  providerName: string
  status: PaymentStatus
  amount: number
  transactionId: string
  trxNumber: string
  transactionStatus: TransactionStatus
  /** false untuk QRIS statis: butuh aksi konfirmasi tersendiri. */
  settlesOnCreate: boolean
}

/**
 * Baca status pembayaran.
 *
 * Statusnya DITANYAKAN ke provider, bukan dibaca langsung dari baris, supaya
 * jalur yang akan dipakai provider dinamis nanti sudah terpasang sejak sekarang.
 * `StaticQrisProvider` menjawab dengan status tersimpan dan tidak pernah
 * memajukannya sendiri.
 *
 * Fungsi ini TIDAK PERNAH melunaskan apa pun, bahkan kalau provider melaporkan
 * PAID. Menyambungkan `checkStatus` ke `settleTransaction` adalah langkah
 * provider dinamis (docs/qris.md §5 langkah 3b), bukan sesuatu yang aktif diam-diam
 * di v1.
 */
export async function readPaymentStatus(
  paymentId: string,
  db: Db = prisma,
): Promise<PaymentStatusView> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { transaction: { select: { id: true, trxNumber: true, status: true } } },
  })
  if (!payment) throw new NotFoundError('Pembayaran tidak ditemukan')

  const method = parseMethod(payment.method)
  const provider = providerForMethod(method, db)
  const reported = await provider.checkStatus({
    paymentId: payment.id,
    externalId: payment.externalId,
  })

  return {
    paymentId: payment.id,
    method,
    providerName: payment.providerName,
    status: reported ?? parseStatus(payment.status),
    amount: payment.amount,
    transactionId: payment.transaction.id,
    trxNumber: payment.transaction.trxNumber,
    transactionStatus: parseTransactionStatus(payment.transaction.status),
    settlesOnCreate: provider.settlesOnCreate,
  }
}
