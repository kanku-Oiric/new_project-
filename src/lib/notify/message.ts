import type { PaymentMethod, ReportKind } from '../enums'
import { formatRupiah } from '../money'
import type { AggregateComparison, Comparison, SalesAggregate } from '../report'
import { formatClock } from '../time'
import type { MessageRow, MessageSection, ReportMessage } from './types'

/**
 * Nama metode bayar untuk manusia.
 *
 * `Record<PaymentMethod, string>`, bukan rangkaian ternary: menambah metode di
 * `enums.ts` tanpa memberinya nama menjadi error kompilasi di sini, bukan
 * tulisan "QRIS" yang salah di laporan yang dikirim ke pemilik.
 */
const METODE_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Tunai',
  QRIS_STATIC: 'QRIS',
  CASH_OUT: 'Serah tunai (tarik tunai)',
}

/**
 * Menyusun isi laporan — modul murni.
 *
 * Referensi: docs/reporting.md §1, §5
 *
 * Seluruh penamaan angka ditentukan di sini, dan satu aturan tidak bisa
 * ditawar: **angka omzet tidak pernah dinamai "laba"**. Pemilik mengambil
 * keputusan dari nama yang dibacanya, bukan dari rumus yang tidak dilihatnya.
 *
 * Yang juga sengaja TIDAK ada: baris "laba bersih". Biaya di luar HPP tidak
 * tercatat lengkap, jadi laba kotor dan total pengeluaran ditampilkan
 * berdampingan tanpa diselisihkan lalu diberi nama yang lebih besar dari
 * kenyataannya.
 */

export interface ReportMeta {
  kind: ReportKind
  periodKey: string
  /** Label periode untuk manusia, mis. "Jumat, 18 September 2026". */
  periodLabel: string
  storeName: string
  timezone: string
  comparison?: AggregateComparison | null
  aiInsight?: string | null
}

const KIND_LABEL: Record<ReportKind, string> = {
  DAILY: 'Laporan Harian',
  WEEKLY: 'Laporan Mingguan',
  MONTHLY: 'Laporan Bulanan',
}

/** Rata-rata / persentase yang tidak terdefinisi ditulis "—", bukan 0 atau NaN. */
export const EMPTY_VALUE = '—'

export function formatCount(value: number, unit: string): string {
  return `${value.toLocaleString('id-ID')} ${unit}`
}

export function formatPercent(percent: number | null): string {
  if (percent === null) return EMPTY_VALUE
  const sign = percent > 0 ? '+' : ''
  return `${sign}${percent.toFixed(1)}%`
}

function arrowFor(delta: number): string {
  return delta > 0 ? '▲' : delta < 0 ? '▼' : '='
}

export function formatComparison(c: Comparison): string {
  return `${arrowFor(c.delta)} ${formatRupiah(Math.abs(c.delta))} (${formatPercent(c.percent)})`
}

/** Perbandingan untuk angka yang bukan rupiah (jumlah transaksi). */
export function formatCountComparison(c: Comparison): string {
  return `${arrowFor(c.delta)} ${Math.abs(c.delta).toLocaleString('id-ID')} (${formatPercent(
    c.percent,
  )})`
}

function row(label: string, value: string, emphasis = false): MessageRow {
  return emphasis ? { label, value, emphasis } : { label, value }
}

export function buildReportMessage(
  aggregate: SalesAggregate,
  meta: ReportMeta,
): ReportMessage {
  const sections: MessageSection[] = []

  sections.push({
    label: 'Penjualan',
    rows: [
      row('Penjualan Kotor', formatRupiah(aggregate.grossSales)),
      row('Diskon', `−${formatRupiah(aggregate.discounts, { bare: true })}`),
      row('Penjualan Bersih', formatRupiah(aggregate.netSales), true),
      row('Refund', `−${formatRupiah(aggregate.refunds, { bare: true })}`),
      row('Penjualan Bersih − Refund', formatRupiah(aggregate.netSalesAfterRefunds), true),
    ],
  })

  sections.push({
    label: 'Laba kotor',
    rows: [
      row('HPP (harga beli barang terjual)', formatRupiah(aggregate.cogs)),
      row('Laba Kotor', formatRupiah(aggregate.grossProfit), true),
      row('Laba Kotor − Refund', formatRupiah(aggregate.grossProfitAfterRefunds), true),
    ],
  })

  sections.push({
    label: 'Aktivitas',
    rows: [
      row('Transaksi selesai', formatCount(aggregate.transactionCount, 'transaksi')),
      row(
        'Rata-rata per transaksi',
        aggregate.averageTransaction === null
          ? EMPTY_VALUE
          : formatRupiah(aggregate.averageTransaction),
      ),
      row('Item terjual', formatCount(aggregate.itemCount, 'item')),
    ],
  })

  if (aggregate.byMethod.length > 0) {
    sections.push({
      // Labelnya menyebut "uang berpindah", bukan "penjualan", karena sejak ada
      // jasa angka ini memang bukan omzet: ia termasuk titipan yang cuma mampir
      // di laci. Pemilik harus bisa mencocokkannya dengan hitungan fisik laci,
      // dan itu tidak mungkin kalau angkanya omzet.
      label: 'Metode pembayaran (uang yang berpindah, termasuk titipan jasa)',
      rows: aggregate.byMethod.map((m) =>
        row(METODE_LABEL[m.method], `${formatRupiah(m.amount)} · ${formatCount(m.count, 'transaksi')}`),
      ),
    })
  }

  if (aggregate.serviceCount > 0) {
    sections.push({
      label: 'Jasa pembayaran (titipan BUKAN omzet)',
      rows: [
        ...aggregate.servicesByKind.map((j) =>
          row(
            j.label,
            `${formatCount(j.count, 'transaksi')} · titipan ${formatRupiah(j.passthrough)} · admin ${formatRupiah(j.fee)}`,
          ),
        ),
        row('Pendapatan admin (masuk omzet)', formatRupiah(aggregate.serviceFees), true),
        row('Titipan diteruskan ke provider', formatRupiah(aggregate.passthroughOut)),
        ...(aggregate.passthroughIn > 0
          ? [row('Titipan masuk (tarik tunai)', formatRupiah(aggregate.passthroughIn))]
          : []),
      ],
    })
  }

  if (aggregate.providerBalances.length > 0) {
    sections.push({
      label: 'Saldo provider (keadaan saat laporan dibuat)',
      rows: aggregate.providerBalances.map((p) =>
        row(p.providerName, formatRupiah(p.saldo), p.saldo < 0),
      ),
    })
  }

  if (aggregate.expenseTotal > 0) {
    sections.push({
      label: 'Pengeluaran',
      rows: [
        ...aggregate.expensesByCategory.map((c) => row(c.kategori, formatRupiah(c.amount))),
        row('Total pengeluaran', formatRupiah(aggregate.expenseTotal), true),
        row('— dari laci kas', formatRupiah(aggregate.expenseFromCashDrawer)),
        row('— dari sumber lain', formatRupiah(aggregate.expenseFromOther)),
      ],
    })
  }

  if (aggregate.shifts.length > 0) {
    sections.push({
      label: 'Shift (jam buka–tutup, bisa melewati tengah malam)',
      rows: aggregate.shifts.map((s) => {
        const jam = `${formatClock(s.openedAt, meta.timezone)}–${
          s.closedAt ? formatClock(s.closedAt, meta.timezone) : 'belum tutup'
        }`
        const selisih =
          s.difference === null ? 'belum dihitung' : `selisih ${formatRupiah(s.difference)}`

        // Tanggal ikut di label untuk laporan mingguan/bulanan.
        //
        // Dulu labelnya hanya nama kasir. Kasir yang bekerja tiga hari dalam
        // sepekan menghasilkan TIGA baris berjudul "Kasir Budi" — pembaca tidak
        // bisa tahu baris mana hari mana, dan React melaporkan duplicate key
        // karena label dipakai sebagai identitas baris.
        const label = meta.kind === 'DAILY' ? s.cashierName : `${s.cashierName} · ${s.businessDate}`
        return row(label, `${jam} · ${selisih}`)
      }),
    })
  }

  if (aggregate.topByQty.length > 0) {
    sections.push({
      label: 'Terlaris (jumlah)',
      rows: aggregate.topByQty.map((p) =>
        row(p.productName, `${formatCount(p.qty, 'pcs')} · ${formatRupiah(p.netSales)}`),
      ),
    })
  }

  if (aggregate.topByProfit.length > 0) {
    // Daftar kedua, sengaja terpisah: barang paling ramai sering bukan barang
    // paling menguntungkan.
    sections.push({
      label: 'Penyumbang laba kotor terbesar',
      rows: aggregate.topByProfit.map((p) => row(p.productName, formatRupiah(p.grossProfit))),
    })
  }

  if (aggregate.stockAlerts.length > 0) {
    sections.push({
      label: 'Stok perlu diperiksa',
      rows: aggregate.stockAlerts.map((s) =>
        row(
          s.productName,
          s.stok < 0
            ? `MINUS ${s.stok} ${s.satuan}`
            : `${s.stok} ${s.satuan} (minimum ${s.stokMinimum})`,
        ),
      ),
    })
  }

  const pengawasan: MessageRow[] = [
    row('Void', formatCount(aggregate.voidCount, 'transaksi')),
    row('Refund', formatCount(aggregate.refundCount, 'kali')),
    row('Total selisih kas', formatRupiah(aggregate.cashDifferenceTotal)),
  ]
  if (aggregate.cancelledCount > 0) {
    pengawasan.push(row('Dibatalkan (belum lunas)', formatCount(aggregate.cancelledCount, 'transaksi')))
  }
  sections.push({ label: 'Pengawasan', rows: pengawasan })

  if (meta.comparison) {
    const c = meta.comparison
    sections.push({
      label: 'Dibanding periode sebelumnya',
      rows: [
        row('Penjualan Bersih', formatComparison(c.netSales)),
        row('Laba Kotor', formatComparison(c.grossProfit)),
        row('Transaksi', formatCountComparison(c.transactionCount)),
        row('Refund', formatComparison(c.refunds)),
      ],
    })
  }

  const footnotes = [
    'Refund dihitung pada tanggal refund terjadi, bukan tanggal penjualan asal, supaya laporan cocok dengan uang di laci.',
    'Transaksi yang dibatalkan (void) tidak masuk perhitungan penjualan sama sekali.',
  ]

  return {
    title: `${KIND_LABEL[meta.kind]} · ${meta.storeName}`,
    periodLabel: meta.periodLabel,
    sections,
    footnotes,
    ...(meta.aiInsight ? { aiInsight: meta.aiInsight } : {}),
  }
}
