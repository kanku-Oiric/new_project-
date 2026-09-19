import { formatRupiah } from '../money'

/**
 * Struk.
 *
 * Batas modulnya sengaja diletakkan di sini (docs/architecture.md §13):
 *
 *   buildReceipt(data) → ReceiptModel     ← fungsi murni, bisa diuji
 *          ↓
 *   renderer                              ← satu-satunya bagian yang diganti
 *
 * v1 hanya punya renderer HTML untuk printer browser/sistem. Driver thermal
 * printer di luar scope; menambah renderer ESC/POS nanti cukup menambah satu
 * fungsi yang menerima ReceiptModel, tanpa menyentuh logika struk maupun kode
 * transaksi.
 */

export type ReceiptWidth = '58' | '80' | 'a4'

export interface ReceiptStore {
  name: string
  address: string
  phone: string
  footer: string
}

export interface ReceiptSourceItem {
  productName: string
  sku: string
  qty: number
  unitPrice: number
  itemDiscount: number
  allocatedTxDiscount: number
  lineGross: number
  lineFinal: number
}

export interface ReceiptSource {
  trxNumber: string
  createdAt: Date
  cashierName: string
  items: ReceiptSourceItem[]
  grossSubtotal: number
  itemDiscountTotal: number
  transactionDiscount: number
  netTotal: number
  paymentMethod: string
  amountTendered: number | null
  changeAmount: number | null
  status: string
}

export interface ReceiptLine {
  name: string
  /** "3 × Rp 7.000" */
  qtyPrice: string
  /** Diskon baris, sudah digabung item + bagian diskon transaksi. */
  discountLabel: string | null
  amount: string
}

export interface ReceiptTotalRow {
  label: string
  value: string
  emphasis?: boolean
}

export interface ReceiptModel {
  store: ReceiptStore
  trxNumber: string
  dateLabel: string
  timeLabel: string
  cashierName: string
  lines: ReceiptLine[]
  totals: ReceiptTotalRow[]
  paymentLabel: string
  footer: string
  /** Transaksi yang belum lunas dicetak dengan penanda jelas. */
  draftNotice: string | null
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Tunai',
  QRIS_STATIC: 'QRIS',
}

function formatDateTime(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return {
    date: `${get('day')}/${get('month')}/${get('year')}`,
    time: `${get('hour')}:${get('minute')}`,
  }
}

/**
 * Susun struk. Murni — tidak menyentuh DB, tidak memanggil new Date().
 *
 * Diskon item dan bagian diskon transaksi DIGABUNG menjadi satu baris diskon
 * per item. Pelanggan tidak perlu tahu mekanisme alokasi largest-remainder;
 * yang perlu terbaca adalah berapa yang ia bayar untuk barang itu. Totalnya
 * tetap dirinci di bagian bawah.
 */
export function buildReceipt(
  source: ReceiptSource,
  store: ReceiptStore,
  timeZone: string,
): ReceiptModel {
  const { date, time } = formatDateTime(source.createdAt, timeZone)

  const lines: ReceiptLine[] = source.items.map((item) => {
    const discount = item.itemDiscount + item.allocatedTxDiscount
    return {
      name: item.productName,
      qtyPrice: `${item.qty} × ${formatRupiah(item.unitPrice, { bare: true })}`,
      discountLabel: discount > 0 ? `Diskon −${formatRupiah(discount, { bare: true })}` : null,
      amount: formatRupiah(item.lineFinal, { bare: true }),
    }
  })

  const totals: ReceiptTotalRow[] = [
    { label: 'Subtotal', value: formatRupiah(source.grossSubtotal, { bare: true }) },
  ]

  if (source.itemDiscountTotal > 0) {
    totals.push({
      label: 'Diskon item',
      value: `−${formatRupiah(source.itemDiscountTotal, { bare: true })}`,
    })
  }
  if (source.transactionDiscount > 0) {
    totals.push({
      label: 'Diskon transaksi',
      value: `−${formatRupiah(source.transactionDiscount, { bare: true })}`,
    })
  }

  totals.push({ label: 'TOTAL', value: formatRupiah(source.netTotal, { bare: true }), emphasis: true })

  if (source.amountTendered !== null) {
    totals.push({ label: 'Tunai', value: formatRupiah(source.amountTendered, { bare: true }) })
  }
  if (source.changeAmount !== null) {
    totals.push({ label: 'Kembali', value: formatRupiah(source.changeAmount, { bare: true }) })
  }

  return {
    store,
    trxNumber: source.trxNumber,
    dateLabel: date,
    timeLabel: time,
    cashierName: source.cashierName,
    lines,
    totals,
    paymentLabel: METHOD_LABEL[source.paymentMethod] ?? source.paymentMethod,
    footer: store.footer,
    // Struk transaksi yang belum lunas tidak boleh terlihat seperti bukti bayar.
    draftNotice:
      source.status === 'COMPLETED'
        ? null
        : source.status === 'VOIDED'
          ? '*** TRANSAKSI DIBATALKAN ***'
          : '*** BELUM LUNAS — BUKAN BUKTI PEMBAYARAN ***',
  }
}

/** Lebar kertas dalam CSS, dipakai renderer HTML. */
export function receiptPageWidth(width: ReceiptWidth): string {
  if (width === '58') return '58mm'
  if (width === '80') return '80mm'
  return '210mm'
}
