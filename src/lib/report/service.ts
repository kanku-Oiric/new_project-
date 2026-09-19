import type { Db } from '../audit'
import { config } from '../config'
import { isUniqueViolation } from '../db/errors'
import { prisma } from '../db/prisma'
import {
  PaymentMethodSchema,
  ShiftStatusSchema,
  TransactionStatusSchema,
  type PaymentMethod,
  type ReportChannel,
  type ReportKind,
  type ReportTrigger,
  type TransactionStatus,
} from '../enums'
import { NotFoundError, ValidationError } from '../errors'
import { createLogger } from '../logger'
import { backoffDelayMs } from '../notify/backoff'
import { buildReportMessage } from '../notify/message'
import { notificationProviderFor, configuredChannels } from '../notify/registry'
import { sendWithRetry, type SendWithRetryOptions } from '../notify/send'
import type { NotificationProvider, ReportMessage } from '../notify/types'
import {
  DEFAULT_BACKLOG_CAP,
  assertPeriodKey,
  missingPeriods,
  periodKeyFor,
  periodRange,
  previousPeriodKey,
  type PeriodRange,
} from '../schedule'
import { getSetting } from '../settings'
import { toBusinessDate } from '../time'
import {
  aggregateSales,
  compareAggregates,
  type ReportInput,
  type SalesAggregate,
} from './index'
import { periodLabel } from './labels'

const log = createLogger('report')

/**
 * Laporan: pengumpulan baris, penyusunan pesan, dan pengiriman.
 *
 * Referensi: docs/reporting.md §7, docs/architecture.md §10–11
 *
 * Pembagian tugas di file ini disengaja: fungsi di sini HANYA mengambil baris
 * mentah dan menulis status pengiriman. Seluruh matematika ada di modul murni
 * `report/index.ts`, dan seluruh perhitungan periode di `schedule/index.ts`.
 * Karena itu skenario "server mati 3 hari" bisa diuji dengan jam palsu, dan
 * laporan tanggal berapa pun bisa dihitung ulang kapan pun.
 */

// ─────────────────────────────── Pengumpulan baris ───────────────────────────────

function parseTransactionStatus(raw: string): TransactionStatus {
  const parsed = TransactionStatusSchema.safeParse(raw)
  // Status tak dikenal tidak boleh diam-diam dihitung sebagai penjualan.
  if (!parsed.success) throw new ValidationError(`Status transaksi tidak dikenal: ${raw}`)
  return parsed.data
}

function parsePaidMethod(raw: string | undefined): PaymentMethod | null {
  if (!raw) return null
  const parsed = PaymentMethodSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Ambil seluruh baris mentah untuk satu rentang businessDate.
 *
 * Perhatikan yang TIDAK ada di query transaksi: filter status. Aturan "VOIDED
 * dikecualikan" ditegakkan fungsi murni `aggregateSales`, supaya bisa diuji
 * tanpa database — bukan disembunyikan di dalam WHERE clause.
 */
export async function collectReportInput(
  range: PeriodRange,
  db: Db = prisma,
): Promise<ReportInput> {
  const where = { businessDate: { gte: range.from, lte: range.to } }

  const [transactions, refunds, expenses, shifts, products] = await Promise.all([
    db.transaction.findMany({
      where,
      include: {
        items: {
          select: {
            productId: true,
            productName: true,
            qty: true,
            lineFinal: true,
            unitCost: true,
          },
        },
        payments: { select: { method: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    db.refund.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.expense.findMany({ where: { ...where, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    db.shift.findMany({
      where,
      include: { cashier: { select: { name: true } } },
      orderBy: { openedAt: 'asc' },
    }),
    // Stok dibaca apa adanya SAAT INI, bukan keadaan di akhir periode — riwayat
    // stok per tanggal ada di stock_movements tapi merekonstruksinya untuk
    // setiap laporan tidak sepadan. Labelnya di pesan menyebutkan hal ini.
    db.product.findMany({
      where: { aktif: true },
      select: { nama: true, stok: true, stokMinimum: true, satuan: true },
      orderBy: { nama: 'asc' },
    }),
  ])

  return {
    transactions: transactions.map((t) => ({
      id: t.id,
      businessDate: t.businessDate,
      status: parseTransactionStatus(t.status),
      grossSubtotal: t.grossSubtotal,
      itemDiscountTotal: t.itemDiscountTotal,
      transactionDiscount: t.transactionDiscount,
      netTotal: t.netTotal,
      cogsTotal: t.cogsTotal,
      paidMethod: parsePaidMethod(t.payments.find((p) => p.status === 'PAID')?.method),
      items: t.items,
    })),
    refunds: refunds.map((r) => ({
      id: r.id,
      businessDate: r.businessDate,
      amount: r.amount,
      cogsAmount: r.cogsAmount,
      method: r.method as ReportInput['refunds'][number]['method'],
    })),
    expenses: expenses.map((e) => ({
      businessDate: e.businessDate,
      kategori: e.kategori,
      amount: e.amount,
      paidFrom: e.paidFrom as ReportInput['expenses'][number]['paidFrom'],
    })),
    shifts: shifts.map((s) => ({
      cashierName: s.cashier.name,
      status: ShiftStatusSchema.catch('OPEN').parse(s.status),
      businessDate: s.businessDate,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      expectedCash: s.expectedCash,
      countedCash: s.countedCash,
      difference: s.difference,
    })),
    stock: products
      .filter((p) => p.stok < 0 || p.stok <= p.stokMinimum)
      .map((p) => ({
        productName: p.nama,
        stok: p.stok,
        stokMinimum: p.stokMinimum,
        satuan: p.satuan,
      })),
  }
}

// ─────────────────────────────── Penyusunan laporan ───────────────────────────────

export interface BuiltReport {
  kind: ReportKind
  periodKey: string
  range: PeriodRange
  label: string
  aggregate: SalesAggregate
  message: ReportMessage
}

/**
 * Susun laporan satu periode.
 *
 * Perbandingan dengan periode sebelumnya hanya untuk mingguan dan bulanan:
 * membandingkan hari Selasa dengan hari Senin lebih sering menyesatkan daripada
 * membantu, karena pola belanja toko berbeda per hari dalam minggu.
 */
export async function buildReport(
  kind: ReportKind,
  periodKey: string,
  db: Db = prisma,
): Promise<BuiltReport> {
  assertPeriodKey(kind, periodKey)

  const range = periodRange(kind, periodKey)
  const [input, storeName] = await Promise.all([
    collectReportInput(range, db),
    getSetting('storeName', db),
  ])
  const aggregate = aggregateSales(input)

  let comparison = null
  if (kind !== 'DAILY') {
    const previousKey = previousPeriodKey(kind, periodKey)
    const previousInput = await collectReportInput(periodRange(kind, previousKey), db)
    comparison = compareAggregates(aggregate, aggregateSales(previousInput))
  }

  const label = periodLabel(kind, periodKey)

  return {
    kind,
    periodKey,
    range,
    label,
    aggregate,
    message: buildReportMessage(aggregate, {
      kind,
      periodKey,
      periodLabel: label,
      storeName,
      timezone: config.timezone,
      comparison,
    }),
  }
}

// ─────────────────────────────── Pengiriman ───────────────────────────────

export interface DeliverOptions {
  db?: Db
  now?: Date
  requestedByUserId?: string | null
  sendOptions?: SendWithRetryOptions
  /** Di-inject test supaya tidak ada request keluar. */
  providerFor?: (channel: ReportChannel) => NotificationProvider
}

export interface DeliveryResult {
  status: 'SENT' | 'FAILED' | 'SKIPPED'
  deliveryId: string | null
  kind: ReportKind
  periodKey: string
  channel: ReportChannel
  attempts: number
  error: string | null
  /** Alasan dilewati, mis. sudah pernah dikirim otomatis. */
  skippedReason?: string
}

function dedupeKeyFor(
  trigger: ReportTrigger,
  kind: ReportKind,
  periodKey: string,
  channel: ReportChannel,
): string | null {
  // AUTO didedup di level DATABASE lewat kolom nullable unique. MANUAL selalu
  // null, sehingga menekan "Kirim laporan sekarang" dua kali tidak pernah
  // menabrak constraint (docs/reporting.md §6.3).
  return trigger === 'AUTO' ? `${kind}|${periodKey}|${channel}` : null
}

async function finishDelivery(
  db: Db,
  deliveryId: string,
  outcome: { ok: boolean; attempts: number; error: string | null; permanent: boolean },
  previousAttempts: number,
  now: Date,
): Promise<void> {
  const attempts = previousAttempts + outcome.attempts

  if (outcome.ok) {
    await db.reportDelivery.update({
      where: { id: deliveryId },
      data: { status: 'SENT', sentAt: now, attempts, lastError: null, nextAttemptAt: null },
    })
    return
  }

  // Gagal permanen (webhook dihapus, token dicabut) TIDAK dijadwalkan ulang:
  // mencoba lagi tiap sepuluh menit selamanya hanya menumpuk baris gagal yang
  // sama. Baris itu tetap ada di daftar dan bisa di-retry manual setelah
  // pengaturannya dibetulkan.
  const nextAttemptAt = outcome.permanent
    ? null
    : new Date(now.getTime() + backoffDelayMs(Math.min(attempts, 5)))

  await db.reportDelivery.update({
    where: { id: deliveryId },
    data: { status: 'FAILED', attempts, lastError: outcome.error, nextAttemptAt },
  })
}

/**
 * Kirim satu laporan ke satu saluran.
 *
 * Urutannya penting: baris `report_deliveries` DIKLAIM lebih dulu, baru
 * laporannya disusun dan dikirim. Klaim itulah satu-satunya penjaga
 * anti-kirim-ganda, dan ia harus terjadi sebelum ada pesan apa pun yang keluar.
 */
export async function deliverReport(
  kind: ReportKind,
  periodKey: string,
  channel: ReportChannel,
  trigger: ReportTrigger,
  options: DeliverOptions = {},
): Promise<DeliveryResult> {
  const db = options.db ?? prisma
  const now = options.now ?? new Date()
  assertPeriodKey(kind, periodKey)

  const base = { kind, periodKey, channel, attempts: 0, error: null } as const

  let deliveryId: string
  try {
    const created = await db.reportDelivery.create({
      data: {
        kind,
        periodKey,
        channel,
        trigger,
        status: 'PENDING',
        attempts: 0,
        // Diisi sejak awal supaya baris yang tertinggal PENDING karena proses
        // mati di tengah kirim bisa dipungut catch-up berikutnya.
        nextAttemptAt: now,
        requestedByUserId: options.requestedByUserId ?? null,
        dedupeKey: dedupeKeyFor(trigger, kind, periodKey, channel),
      },
    })
    deliveryId = created.id
  } catch (e) {
    if (isUniqueViolation(e)) {
      return {
        ...base,
        status: 'SKIPPED',
        deliveryId: null,
        skippedReason: 'Sudah pernah diklaim untuk pengiriman otomatis',
      }
    }
    throw e
  }

  return runDelivery(deliveryId, kind, periodKey, channel, 0, options, now)
}

async function runDelivery(
  deliveryId: string,
  kind: ReportKind,
  periodKey: string,
  channel: ReportChannel,
  previousAttempts: number,
  options: DeliverOptions,
  now: Date,
): Promise<DeliveryResult> {
  const db = options.db ?? prisma

  let message: ReportMessage
  try {
    message = (await buildReport(kind, periodKey, db)).message
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error(`gagal menyusun laporan ${kind} ${periodKey}`, e)
    await finishDelivery(
      db,
      deliveryId,
      { ok: false, attempts: 1, error, permanent: true },
      previousAttempts,
      now,
    )
    return {
      status: 'FAILED',
      deliveryId,
      kind,
      periodKey,
      channel,
      attempts: previousAttempts + 1,
      error,
    }
  }

  const provider = options.providerFor
    ? options.providerFor(channel)
    : notificationProviderFor(channel, db)

  const outcome = await sendWithRetry(provider, message, {
    ...options.sendOptions,
    onAttemptFailed: (attempt, error, waitMs) => {
      log.warn(`kirim ${kind} ${periodKey} ke ${channel} gagal (percobaan ${attempt})`, {
        error: error.message,
        retryable: error.retryable,
        waitMs,
      })
      options.sendOptions?.onAttemptFailed?.(attempt, error, waitMs)
    },
  })

  await finishDelivery(db, deliveryId, outcome, previousAttempts, now)

  return {
    status: outcome.ok ? 'SENT' : 'FAILED',
    deliveryId,
    kind,
    periodKey,
    channel,
    attempts: previousAttempts + outcome.attempts,
    error: outcome.error,
  }
}

/** Coba lagi satu baris pengiriman yang sudah ada. */
export async function retryDelivery(
  deliveryId: string,
  options: DeliverOptions = {},
): Promise<DeliveryResult> {
  const db = options.db ?? prisma
  const now = options.now ?? new Date()

  const row = await db.reportDelivery.findUnique({ where: { id: deliveryId } })
  if (!row) throw new NotFoundError('Baris pengiriman tidak ditemukan')
  if (row.status === 'SENT') {
    return {
      status: 'SKIPPED',
      deliveryId,
      kind: row.kind as ReportKind,
      periodKey: row.periodKey,
      channel: row.channel as ReportChannel,
      attempts: row.attempts,
      error: null,
      skippedReason: 'Laporan ini sudah berhasil terkirim',
    }
  }

  await db.reportDelivery.update({
    where: { id: deliveryId },
    data: { status: 'PENDING', lastError: null },
  })

  return runDelivery(
    deliveryId,
    row.kind as ReportKind,
    row.periodKey,
    row.channel as ReportChannel,
    row.attempts,
    options,
    now,
  )
}

// ─────────────────────────────── Catch-up ───────────────────────────────

export interface CatchUpOptions extends DeliverOptions {
  kinds?: ReportKind[]
  channels?: ReportChannel[]
  cap?: number
  /** Jeda antar-kirim supaya tidak menghajar rate limit. */
  betweenSendsMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface CatchUpResult {
  today: string
  channels: ReportChannel[]
  resumed: DeliveryResult[]
  sent: DeliveryResult[]
  failed: DeliveryResult[]
  skipped: number
  note: string | null
}

const ALL_KINDS: ReportKind[] = ['DAILY', 'WEEKLY', 'MONTHLY']
const DEFAULT_BETWEEN_SENDS_MS = 1_500

/**
 * Kirim semua laporan yang terlewat.
 *
 * Ini MEKANISME UTAMA penjadwalan, bukan cadangan: laptop toko dimatikan tiap
 * malam, jadi cron pasti melewatkan laporan. Cron di `scheduler.ts` memanggil
 * fungsi yang sama persis — tidak ada jalur kode kedua yang bisa menyimpang.
 *
 * Tidak pernah melempar. Kegagalan di sini tidak boleh membuat server gagal
 * boot (docs/architecture.md §10.1).
 */
export async function catchUpReports(
  nowInput?: Date,
  options: CatchUpOptions = {},
): Promise<CatchUpResult> {
  const db = options.db ?? prisma
  const now = nowInput ?? new Date()
  const today = toBusinessDate(now, config.timezone)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const betweenSendsMs = options.betweenSendsMs ?? DEFAULT_BETWEEN_SENDS_MS

  const result: CatchUpResult = {
    today,
    channels: [],
    resumed: [],
    sent: [],
    failed: [],
    skipped: 0,
    note: null,
  }

  const channels = options.channels ?? (await configuredChannels(db))
  result.channels = channels

  if (channels.length === 0) {
    // Tidak ada saluran terkonfigurasi bukan kegagalan. Toko yang belum mengisi
    // webhook apa pun tidak boleh menumpuk baris FAILED tiap kali menyala.
    result.note = 'Belum ada saluran notifikasi yang dikonfigurasi'
    return result
  }

  const cap = options.cap ?? (await getSetting('catchUpMaxPeriods', db)) ?? DEFAULT_BACKLOG_CAP

  // 1. Pungut kiriman yang tertinggal: PENDING karena proses mati di tengah
  //    jalan, atau FAILED yang masih layak dicoba lagi.
  const pending = await db.reportDelivery.findMany({
    where: {
      trigger: 'AUTO',
      status: { in: ['PENDING', 'FAILED'] },
      nextAttemptAt: { not: null, lte: now },
    },
    orderBy: [{ periodKey: 'asc' }],
    take: cap,
  })

  for (const row of pending) {
    if (!channels.includes(row.channel as ReportChannel)) continue
    const outcome = await retryDelivery(row.id, { ...options, db, now })
    result.resumed.push(outcome)
    if (outcome.status === 'FAILED') result.failed.push(outcome)
    if (outcome.status === 'SENT') await sleep(betweenSendsMs)
  }

  // 2. Periode baru yang belum pernah diklaim.
  const earliest = await earliestBusinessDate(db)

  for (const kind of options.kinds ?? ALL_KINDS) {
    for (const channel of channels) {
      const lastSent = await db.reportDelivery.findFirst({
        where: { kind, channel, trigger: 'AUTO', status: 'SENT' },
        orderBy: { periodKey: 'desc' },
        select: { periodKey: true },
      })

      const periods = missingPeriods({
        kind,
        lastSentKey: lastSent?.periodKey ?? null,
        earliestKey: earliest ? periodKeyFor(kind, earliest) : null,
        today,
        cap,
      })

      for (const periodKey of periods) {
        const outcome = await deliverReport(kind, periodKey, channel, 'AUTO', {
          ...options,
          db,
          now,
        })

        if (outcome.status === 'SKIPPED') result.skipped++
        else if (outcome.status === 'SENT') result.sent.push(outcome)
        else result.failed.push(outcome)

        if (outcome.status !== 'SKIPPED') await sleep(betweenSendsMs)
      }
    }
  }

  return result
}

/**
 * Tanggal paling awal yang layak dilaporkan.
 *
 * Transaksi pertama lebih dipercaya daripada `installDate`: instalasi bisa
 * dilakukan berminggu-minggu sebelum toko benar-benar memakai sistemnya, dan
 * laporan kosong untuk hari-hari itu hanya kebisingan.
 */
async function earliestBusinessDate(db: Db): Promise<string | null> {
  const first = await db.transaction.findFirst({
    where: { status: 'COMPLETED' },
    orderBy: { businessDate: 'asc' },
    select: { businessDate: true },
  })
  if (first) return first.businessDate

  const installDate = await getSetting('installDate', db)
  return installDate || null
}

/** Dipanggil startup: tidak boleh melempar, apa pun yang terjadi. */
export async function catchUpReportsSafe(now?: Date): Promise<CatchUpResult | null> {
  try {
    const result = await catchUpReports(now)
    log.info('catch-up laporan selesai', {
      today: result.today,
      channels: result.channels,
      terkirim: result.sent.length,
      gagal: result.failed.length,
      dilanjutkan: result.resumed.length,
      dilewati: result.skipped,
      note: result.note,
    })
    return result
  } catch (e) {
    log.error('catch-up laporan gagal total — server tetap berjalan', e)
    return null
  }
}
