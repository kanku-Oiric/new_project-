import 'server-only'
import { prisma } from '../db/prisma'
import { UTF8_BOM, toCsv } from './csv'
import { buildZip, type ZipEntry } from './zip'

/**
 * Export seluruh data ke satu berkas ZIP berisi CSV.
 *
 * Gunanya BUKAN pemulihan — untuk itu ada backup `.db` yang bisa dikembalikan
 * utuh (docs/architecture.md §15). Yang ini untuk hal lain: menyerahkan data ke
 * akuntan, membuka di Excel, atau menyimpan salinan yang tetap bisa dibaca
 * sepuluh tahun lagi walau aplikasi ini sudah tidak ada. CSV bertahan lebih lama
 * daripada perangkat lunak apa pun yang menulisnya.
 *
 * Dua hal yang SENGAJA tidak ikut, dan keduanya bukan kelalaian:
 *
 *   `users.pinHash`  — hash PIN. Tidak ada gunanya di Excel, dan berkas export
 *                      sering berpindah lewat WhatsApp atau flashdisk.
 *   tabel `settings` — memuat webhook Discord dan token Telegram. Siapa pun yang
 *                      memegang webhook itu bisa mengirim pesan ke grup toko.
 *
 * Kolom setiap tabel ditulis eksplisit di bawah, bukan diambil otomatis dari
 * schema. Jadi kolom rahasia yang ditambahkan nanti tidak bisa ikut terbawa
 * tanpa seseorang mengetiknya di sini lebih dulu.
 */

const PRODUCT_COLUMNS = [
  'id', 'sku', 'barcode', 'nama', 'kategori', 'hargaBeli', 'hargaJual',
  'stok', 'stokMinimum', 'satuan', 'aktif', 'createdAt', 'updatedAt',
] as const

const TRANSACTION_COLUMNS = [
  'id', 'trxNumber', 'businessDate', 'shiftId', 'cashierId', 'status',
  'grossSubtotal', 'itemDiscountTotal', 'transactionDiscount', 'netTotal',
  'cogsTotal', 'note', 'createdAt', 'completedAt', 'voidedAt', 'voidedByUserId',
  'voidReason', 'cancelReason',
] as const

const TRANSACTION_ITEM_COLUMNS = [
  'id', 'transactionId', 'productId', 'productName', 'sku', 'unitPrice',
  'unitCost', 'qty', 'lineGross', 'itemDiscount', 'allocatedTxDiscount',
  'lineNet', 'lineFinal', 'refundedQty', 'refundedAmount',
] as const

const PAYMENT_COLUMNS = [
  'id', 'transactionId', 'method', 'status', 'amount', 'amountTendered',
  'changeAmount', 'providerName', 'failureReason', 'createdAt', 'paidAt',
  'confirmedByUserId',
] as const

const REFUND_COLUMNS = [
  'id', 'refundNumber', 'transactionId', 'shiftId', 'businessDate', 'amount',
  'cogsAmount', 'method', 'reason', 'authorizedByUserId', 'createdByUserId',
  'createdAt',
] as const

const REFUND_ITEM_COLUMNS = [
  'id', 'refundId', 'transactionItemId', 'qty', 'amount', 'cogsAmount',
] as const

const EXPENSE_COLUMNS = [
  'id', 'shiftId', 'businessDate', 'kategori', 'amount', 'note', 'paidFrom',
  'createdByUserId', 'createdAt', 'deletedAt', 'deletedByUserId',
] as const

const SHIFT_COLUMNS = [
  'id', 'cashierId', 'status', 'openedAt', 'closedAt', 'openingCash',
  'countedCash', 'expectedCash', 'difference', 'businessDate', 'notes',
  'closedByUserId',
] as const

const STOCK_MOVEMENT_COLUMNS = [
  'id', 'productId', 'qtyChange', 'reason', 'stockBefore', 'stockAfter',
  'refType', 'refId', 'userId', 'note', 'businessDate', 'createdAt',
] as const

const AUDIT_LOG_COLUMNS = [
  'id', 'at', 'userId', 'actorRole', 'action', 'entityType', 'entityId',
  'summary', 'beforeJson', 'afterJson', 'ip', 'deviceLabel',
] as const

/** Tanpa pinHash. Nama kasir dibutuhkan supaya kolom cashierId ada artinya. */
const USER_COLUMNS = ['id', 'name', 'role', 'active', 'createdAt'] as const

const PANDUAN = `ISI BERKAS INI
==============

Semua data toko dalam bentuk CSV. Satu berkas per tabel.

KALAU DIBUKA DI EXCEL DAN SEMUA TEKS MENUMPUK DI SATU KOLOM
-----------------------------------------------------------
Itu normal. Excel versi Indonesia menyangka pemisahnya titik-koma, sedangkan
berkas ini memakai koma (standar CSV). Cara membukanya:

  1. Buka Excel, jangan klik dua kali berkasnya.
  2. Menu Data -> Get Data / From Text-CSV -> pilih berkasnya.
  3. Pada "Delimiter", pilih Comma (Koma).
  4. Load.

Google Sheets dan LibreOffice mengenalinya sendiri tanpa langkah ini.

CATATAN TENTANG ANGKA
---------------------
Semua nominal adalah RUPIAH BULAT, tanpa desimal dan tanpa titik pemisah ribuan.
Angka 12500 berarti Rp 12.500.

Kolom hargaBeli dan unitCost adalah harga beli. Harga beli yang dipakai adalah
harga beli TERAKHIR saat barang itu terjual, bukan rata-rata bergerak.

Waktu ditulis dalam UTC (berakhiran Z). Kolom businessDate adalah tanggal usaha
menurut waktu Indonesia Barat, dan ITULAH yang dipakai semua laporan.

YANG TIDAK ADA DI SINI
----------------------
- PIN pengguna (hash-nya pun tidak ikut).
- Webhook Discord dan token Telegram.

Keduanya dikecualikan dengan sengaja, karena berkas export sering berpindah
lewat WhatsApp atau flashdisk.

BUKAN UNTUK MEMULIHKAN SISTEM
-----------------------------
Untuk memulihkan toko setelah laptop rusak, yang dipakai adalah berkas backup
berekstensi .db di folder backups/, bukan berkas ini. Caranya ada di README.
`

export interface ExportResult {
  fileName: string
  zip: Buffer
  entryCount: number
  rowCounts: Record<string, number>
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(
    now.getMinutes(),
  )}`
}

export async function buildExport(now: Date = new Date()): Promise<ExportResult> {
  // Urutan `orderBy` dipasang di semua query supaya dua export atas data yang
  // sama menghasilkan berkas yang sama — bisa dibandingkan, bisa di-diff.
  const [
    users, products, shifts, transactions, transactionItems,
    payments, refunds, refundItems, expenses, stockMovements, auditLogs,
  ] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.product.findMany({ orderBy: { sku: 'asc' } }),
    prisma.shift.findMany({ orderBy: { openedAt: 'asc' } }),
    prisma.transaction.findMany({ orderBy: { trxNumber: 'asc' } }),
    prisma.transactionItem.findMany({ orderBy: [{ transactionId: 'asc' }, { id: 'asc' }] }),
    prisma.payment.findMany({ orderBy: [{ transactionId: 'asc' }, { createdAt: 'asc' }] }),
    prisma.refund.findMany({ orderBy: { refundNumber: 'asc' } }),
    prisma.refundItem.findMany({ orderBy: [{ refundId: 'asc' }, { id: 'asc' }] }),
    prisma.expense.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.stockMovement.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.auditLog.findMany({ orderBy: { at: 'asc' } }),
  ])

  const tables: { name: string; csv: string; count: number }[] = [
    { name: 'users', csv: toCsv(USER_COLUMNS, users), count: users.length },
    { name: 'products', csv: toCsv(PRODUCT_COLUMNS, products), count: products.length },
    { name: 'shifts', csv: toCsv(SHIFT_COLUMNS, shifts), count: shifts.length },
    {
      name: 'transactions',
      csv: toCsv(TRANSACTION_COLUMNS, transactions),
      count: transactions.length,
    },
    {
      name: 'transaction_items',
      csv: toCsv(TRANSACTION_ITEM_COLUMNS, transactionItems),
      count: transactionItems.length,
    },
    { name: 'payments', csv: toCsv(PAYMENT_COLUMNS, payments), count: payments.length },
    { name: 'refunds', csv: toCsv(REFUND_COLUMNS, refunds), count: refunds.length },
    {
      name: 'refund_items',
      csv: toCsv(REFUND_ITEM_COLUMNS, refundItems),
      count: refundItems.length,
    },
    { name: 'expenses', csv: toCsv(EXPENSE_COLUMNS, expenses), count: expenses.length },
    {
      name: 'stock_movements',
      csv: toCsv(STOCK_MOVEMENT_COLUMNS, stockMovements),
      count: stockMovements.length,
    },
    { name: 'audit_logs', csv: toCsv(AUDIT_LOG_COLUMNS, auditLogs), count: auditLogs.length },
  ]

  const entries: ZipEntry[] = [
    { name: 'BACA-DULU.txt', data: Buffer.from(PANDUAN, 'utf8') },
    ...tables.map((t) => ({
      name: `${t.name}.csv`,
      data: Buffer.from(UTF8_BOM + t.csv, 'utf8'),
    })),
  ]

  const rowCounts: Record<string, number> = {}
  for (const t of tables) rowCounts[t.name] = t.count

  return {
    fileName: `export-toko-${stamp(now)}.zip`,
    zip: buildZip(entries, now),
    entryCount: entries.length,
    rowCounts,
  }
}
