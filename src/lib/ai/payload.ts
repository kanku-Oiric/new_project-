import type { AggregateComparison, SalesAggregate } from '../report'

/**
 * Payload yang dikirim ke Gemini — satu-satunya data toko yang pernah keluar
 * dari jaringan lokal atas nama fitur ini.
 *
 * ATURAN IMPOR BERKAS INI: tidak boleh mengimpor `settings`, `config`, `prisma`,
 * atau apa pun dari `auth/`. Bukan karena disaring belakangan, tapi karena
 * jalurnya tidak dibuat. Ditegakkan test yang memindai daftar impor berkas ini
 * (src/lib/ai/ai.test.ts), bukan kesepakatan.
 *
 * Yang masuk hanya angka agregat penjualan dan nama produk/kategori. Yang TIDAK
 * punya jalur masuk:
 *
 *   - webhook Discord, token Telegram, dan seluruh isi tabel `settings`
 *     (termasuk nama toko — modelnya tidak membutuhkannya, jadi ia tidak dikirim)
 *   - PIN dan hash-nya
 *   - data pelanggan (v1 memang tidak menyimpannya sama sekali)
 *   - nama kasir. Laporan ini untuk menilai penjualan, bukan menilai orang, dan
 *     mengirim nama karyawan ke layanan pihak ketiga tidak dibutuhkan analisis
 *     mana pun. Selisih kas tetap dikirim sebagai ANGKA TOTAL, tanpa pemiliknya.
 *   - nomor transaksi, id, dan timestamp — tidak menambah apa pun bagi analisis
 *     agregat, dan hanya memperbesar jejak yang keluar
 *
 * `buildAiPayload` menerima `SalesAggregate`, bukan `ReportInput` mentah. Baris
 * transaksi per-item tidak pernah sampai ke sini.
 */

export type AiReportKind = 'WEEKLY' | 'MONTHLY'

export interface AiPayloadPenjualan {
  kotor: number
  diskon: number
  bersih: number
  hpp: number
  labaKotor: number
  refund: number
  bersihSetelahRefund: number
  labaKotorSetelahRefund: number
  jumlahTransaksi: number
  jumlahItem: number
  /** null kalau tidak ada transaksi — bukan 0, supaya model tidak menyimpulkan nol. */
  rataRataTransaksi: number | null
}

export interface AiPayloadPerbandingan {
  bersihSebelumnya: number
  labaKotorSebelumnya: number
  jumlahTransaksiSebelumnya: number
  refundSebelumnya: number
}

export interface AiPayload {
  jenis: AiReportKind
  periode: string
  mataUang: 'IDR'
  catatanSatuan: string
  penjualan: AiPayloadPenjualan
  metodePembayaran: { metode: string; jumlahTransaksi: number; total: number }[]
  pengeluaran: {
    total: number
    dariLaciKas: number
    perKategori: { kategori: string; total: number }[]
  }
  produkTerlaris: { nama: string; qty: number; penjualanBersih: number }[]
  produkLabaTertinggi: { nama: string; labaKotor: number; qty: number }[]
  kas: { selisihTotal: number; jumlahShift: number }
  stok: { dibawahMinimum: number; minus: number }
  pembatalan: { void: number; refund: number; dibatalkan: number }
  perbandingan: AiPayloadPerbandingan | null
}

/** Batas jumlah baris daftar, supaya payload tidak tumbuh tanpa batas. */
const MAX_LIST = 5

export function buildAiPayload(
  aggregate: SalesAggregate,
  meta: { kind: AiReportKind; periodKey: string },
  comparison: AggregateComparison | null = null,
): AiPayload {
  return {
    jenis: meta.kind,
    periode: meta.periodKey,
    mataUang: 'IDR',
    catatanSatuan:
      'Semua nominal adalah rupiah bulat tanpa desimal. 12500 berarti Rp 12.500.',
    penjualan: {
      kotor: aggregate.grossSales,
      diskon: aggregate.discounts,
      bersih: aggregate.netSales,
      hpp: aggregate.cogs,
      labaKotor: aggregate.grossProfit,
      refund: aggregate.refunds,
      bersihSetelahRefund: aggregate.netSalesAfterRefunds,
      labaKotorSetelahRefund: aggregate.grossProfitAfterRefunds,
      jumlahTransaksi: aggregate.transactionCount,
      jumlahItem: aggregate.itemCount,
      rataRataTransaksi: aggregate.averageTransaction,
    },
    metodePembayaran: aggregate.byMethod.map((m) => ({
      metode: m.method,
      jumlahTransaksi: m.count,
      total: m.amount,
    })),
    pengeluaran: {
      total: aggregate.expenseTotal,
      dariLaciKas: aggregate.expenseFromCashDrawer,
      perKategori: aggregate.expensesByCategory
        .slice(0, MAX_LIST)
        .map((c) => ({ kategori: c.kategori, total: c.amount })),
    },
    produkTerlaris: aggregate.topByQty.slice(0, MAX_LIST).map((p) => ({
      nama: p.productName,
      qty: p.qty,
      penjualanBersih: p.netSales,
    })),
    produkLabaTertinggi: aggregate.topByProfit.slice(0, MAX_LIST).map((p) => ({
      nama: p.productName,
      labaKotor: p.grossProfit,
      qty: p.qty,
    })),
    kas: {
      selisihTotal: aggregate.cashDifferenceTotal,
      // Jumlahnya saja. Nama kasir dan selisih per orang sengaja tidak ikut.
      jumlahShift: aggregate.shifts.length,
    },
    stok: {
      dibawahMinimum: aggregate.stockAlerts.filter((s) => s.stok >= 0).length,
      minus: aggregate.stockAlerts.filter((s) => s.stok < 0).length,
    },
    pembatalan: {
      void: aggregate.voidCount,
      refund: aggregate.refundCount,
      dibatalkan: aggregate.cancelledCount,
    },
    perbandingan: comparison
      ? {
          bersihSebelumnya: comparison.netSales.previous,
          labaKotorSebelumnya: comparison.grossProfit.previous,
          jumlahTransaksiSebelumnya: comparison.transactionCount.previous,
          refundSebelumnya: comparison.refunds.previous,
        }
      : null,
  }
}

/**
 * Daftar kunci tingkat atas yang SAH ada di payload.
 *
 * Dipakai test untuk membuktikan tidak ada kunci baru yang menyelinap masuk saat
 * seseorang menambah field di `SalesAggregate`. Menambah data yang dikirim ke
 * luar toko harus berupa keputusan yang terlihat di diff, bukan efek samping.
 */
export const AI_PAYLOAD_KEYS = [
  'jenis',
  'periode',
  'mataUang',
  'catatanSatuan',
  'penjualan',
  'metodePembayaran',
  'pengeluaran',
  'produkTerlaris',
  'produkLabaTertinggi',
  'kas',
  'stok',
  'pembatalan',
  'perbandingan',
] as const
