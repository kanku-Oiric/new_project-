import 'server-only'
import { listBackups } from '../backup'
import { config } from '../config'
import { prisma } from '../db/prisma'
import { buildReport } from '../report/service'
import type { SalesAggregate } from '../report'
import { periodKeyFor } from '../schedule'
import { toBusinessDate } from '../time'
import { AUTO_CANCEL_REASON } from '../transaction/void-rules'

/**
 * Data untuk dashboard pemilik.
 *
 * Halaman ini menjawab satu pertanyaan: **apa yang butuh perhatian saya hari
 * ini?** Karena itu isinya bukan sekadar angka penjualan, tapi juga hal-hal yang
 * sistem TIDAK bisa selesaikan sendiri dan akan terus menggantung sampai ada
 * manusia yang mengurusnya.
 */

/**
 * Berapa hari ke belakang kewajiban manual ditampilkan.
 *
 * Bukan "semua": daftar yang tidak pernah kosong akan berhenti dibaca, dan
 * daftar yang berhenti dibaca sama tidak bergunanya dengan tidak ada daftar.
 * Yang lebih tua tetap ada di /transaksi dan di audit log.
 */
const OBLIGATION_DAYS = 30

export type ObligationKind = 'VOID_QRIS_PAID' | 'QRIS_AUTO_CANCELLED'

export interface ManualObligation {
  kind: ObligationKind
  transactionId: string
  trxNumber: string
  businessDate: string
  amount: number
  /** Apa yang harus dilakukan pemilik, dalam satu kalimat. */
  action: string
  at: Date
  cashierName: string
}

export interface DeliveryStatus {
  id: string
  kind: string
  periodKey: string
  channel: string
  status: string
  attempts: number
  lastError: string | null
  createdAt: Date
  sentAt: Date | null
}

export interface BackupStatus {
  count: number
  latestFile: string | null
  latestAt: Date | null
  /** Dari audit log BACKUP_RUN terakhir — apakah backup itu terbukti bisa dibuka. */
  latestVerified: boolean | null
  latestTransactionCount: number | null
  mirrorConfigured: boolean
}

export interface DashboardData {
  businessDate: string
  today: SalesAggregate
  month: SalesAggregate
  monthKey: string
  obligations: ManualObligation[]
  obligationDays: number
  deliveries: DeliveryStatus[]
  failedDeliveryCount: number
  backup: BackupStatus
  lowStockCount: number
  negativeStockCount: number
  openShiftCount: number
}

function daysAgo(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 86_400_000)
  return toBusinessDate(d, config.timezone)
}

/**
 * Kewajiban yang hanya bisa diselesaikan manusia.
 *
 * Dua bentuk, dan keduanya soal uang yang ada di rekening tapi tidak cocok dengan
 * catatan:
 *
 * 1. **VOID_QRIS_PAID** — transaksi QRIS yang sudah `PAID` lalu di-void. Barang
 *    kembali, pencatatan bersih, tapi uangnya masih di rekening toko. Pemilik
 *    harus mengembalikannya lewat transfer atau tunai; sistem ini tidak punya
 *    jalan ke rekening (§9.2).
 *
 * 2. **QRIS_AUTO_CANCELLED** — transaksi QRIS yang masih PENDING saat shift
 *    ditutup, lalu dibatalkan otomatis. Keputusan itu benar: penutupan shift
 *    tidak boleh terjebak transaksi terlantar. Tapi ia dibuat TANPA mengetahui
 *    apakah uangnya benar-benar masuk — dan pelanggan yang membayar pada
 *    19:57 untuk shift yang ditutup 20:00 tidak tahu-menahu soal itu. Yang bisa
 *    menjawabnya hanya mutasi rekening.
 *
 * Sistem TIDAK melacak apakah kewajiban ini sudah diselesaikan. Melacaknya berarti
 * mengklaim tahu sesuatu yang buktinya ada di luar sistem; yang bisa dilakukan
 * halaman ini adalah memastikan tidak ada yang lupa.
 */
export async function listManualObligations(now: Date = new Date()): Promise<ManualObligation[]> {
  const since = daysAgo(now, OBLIGATION_DAYS)

  const rows = await prisma.transaction.findMany({
    where: {
      businessDate: { gte: since },
      status: { in: ['VOIDED', 'CANCELLED'] },
      payments: { some: { method: { not: 'CASH' } } },
    },
    select: {
      id: true,
      trxNumber: true,
      businessDate: true,
      status: true,
      netTotal: true,
      voidedAt: true,
      createdAt: true,
      cancelReason: true,
      cashier: { select: { name: true } },
      payments: { select: { method: true, status: true, amount: true, paidAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const obligations: ManualObligation[] = []

  for (const trx of rows) {
    const nonCash = trx.payments.filter((p) => p.method !== 'CASH')

    // 1. Void atas QRIS yang sudah dibayar.
    //
    // Penandanya `paidAt`, BUKAN `status === 'PAID'`. Void menimpa status seluruh
    // pembayaran menjadi CANCELLED, jadi setelah void tidak ada satu pun baris
    // yang berstatus PAID — memeriksa status akan membuat daftar ini selalu kosong
    // tepat untuk kasus yang paling penting. `paidAt` tidak pernah dihapus, dan
    // itulah bukti bahwa uangnya memang pernah masuk. Ditemukan oleh
    // tests/e2e-fase7.test.ts, bukan oleh pemilik yang kehilangan uang.
    if (trx.status === 'VOIDED' && nonCash.some((p) => p.paidAt !== null)) {
      obligations.push({
        kind: 'VOID_QRIS_PAID',
        transactionId: trx.id,
        trxNumber: trx.trxNumber,
        businessDate: trx.businessDate,
        amount: trx.netTotal,
        action: 'Uang QRIS sudah masuk rekening. Kembalikan ke pelanggan lewat transfer atau tunai.',
        at: trx.voidedAt ?? trx.createdAt,
        cashierName: trx.cashier.name,
      })
      continue
    }

    // 2. QRIS yang dibatalkan otomatis saat tutup shift.
    if (trx.status === 'CANCELLED' && trx.cancelReason === AUTO_CANCEL_REASON) {
      obligations.push({
        kind: 'QRIS_AUTO_CANCELLED',
        transactionId: trx.id,
        trxNumber: trx.trxNumber,
        businessDate: trx.businessDate,
        amount: trx.netTotal,
        action:
          'Periksa mutasi rekening. Kalau uangnya ternyata masuk, catat penjualannya ulang atau kembalikan ke pelanggan.',
        at: trx.createdAt,
        cashierName: trx.cashier.name,
      })
    }
  }

  return obligations
}

/** Status verifikasi backup terakhir, dibaca dari audit log BACKUP_RUN. */
async function readBackupStatus(): Promise<BackupStatus> {
  const backups = listBackups()
  const latest = backups[0] ?? null

  const auditRow = await prisma.auditLog.findFirst({
    where: { action: 'BACKUP_RUN' },
    orderBy: { at: 'desc' },
    select: { afterJson: true },
  })

  let latestVerified: boolean | null = null
  let latestTransactionCount: number | null = null

  if (auditRow?.afterJson) {
    try {
      const parsed = JSON.parse(auditRow.afterJson) as {
        verified?: unknown
        transactionCount?: unknown
      }
      if (typeof parsed.verified === 'boolean') latestVerified = parsed.verified
      if (typeof parsed.transactionCount === 'number') {
        latestTransactionCount = parsed.transactionCount
      }
    } catch {
      // Baris audit yang tidak bisa di-parse bukan alasan menggagalkan dashboard.
      // Statusnya tetap null, dan null artinya "tidak diketahui" — bukan "aman".
    }
  }

  return {
    count: backups.length,
    latestFile: latest?.file ?? null,
    latestAt: latest?.modifiedAt ?? null,
    latestVerified,
    latestTransactionCount,
    mirrorConfigured: config.backup.mirrorDir !== null,
  }
}

export async function loadDashboard(now: Date = new Date()): Promise<DashboardData> {
  const businessDate = toBusinessDate(now, config.timezone)
  const monthKey = periodKeyFor('MONTHLY', businessDate)

  const [todayReport, monthReport, obligations, deliveries, backup, stock, openShiftCount] =
    await Promise.all([
      buildReport('DAILY', businessDate),
      buildReport('MONTHLY', monthKey),
      listManualObligations(now),
      prisma.reportDelivery.findMany({
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          kind: true,
          periodKey: true,
          channel: true,
          status: true,
          attempts: true,
          lastError: true,
          createdAt: true,
          sentAt: true,
        },
      }),
      readBackupStatus(),
      prisma.product.findMany({
        where: { aktif: true },
        select: { stok: true, stokMinimum: true },
      }),
      prisma.shift.count({ where: { status: 'OPEN' } }),
    ])

  return {
    businessDate,
    today: todayReport.aggregate,
    month: monthReport.aggregate,
    monthKey,
    obligations,
    obligationDays: OBLIGATION_DAYS,
    deliveries,
    failedDeliveryCount: deliveries.filter((d) => d.status === 'FAILED').length,
    backup,
    lowStockCount: stock.filter((p) => p.stok <= p.stokMinimum && p.stok >= 0).length,
    negativeStockCount: stock.filter((p) => p.stok < 0).length,
    openShiftCount,
  }
}
