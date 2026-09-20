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

export interface ReceiptSourceService {
  label: string
  direction: string
  providerName: string
  passthroughAmount: number
  serviceFeeAmount: number
  customerRef: string | null
}

export interface ReceiptSource {
  trxNumber: string
  createdAt: Date
  cashierName: string
  items: ReceiptSourceItem[]
  services?: ReceiptSourceService[]
  grossSubtotal: number
  itemDiscountTotal: number
  transactionDiscount: number
  /** OMZET. Untuk transaksi jasa ini BUKAN yang dibayar pelanggan. */
  netTotal: number
  /** BERTANDA. Titipan; negatif berarti toko yang menyerahkan uang. */
  passthroughTotal?: number
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
  CASH_OUT: 'Tunai diserahkan',
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

  // Baris jasa dicetak dengan nominal dan biaya adminnya DIPISAH.
  //
  // Pelanggan yang menyerahkan Rp 102.500 untuk token Rp 100.000 harus bisa
  // melihat ke mana Rp 2.500-nya pergi. Struk yang cuma menulis satu angka
  // gabungan adalah sumber pertengkaran di meja kasir, dan nomor tujuannya ikut
  // dicetak supaya pelanggan bisa memeriksa sebelum meninggalkan toko.
  for (const jasa of source.services ?? []) {
    const masuk = jasa.direction === 'PROVIDER_IN'
    lines.push({
      name: `${jasa.label} (${jasa.providerName})`,
      qtyPrice: jasa.customerRef ? `No. ${jasa.customerRef}` : masuk ? 'Tarik tunai' : 'Titipan',
      discountLabel:
        jasa.serviceFeeAmount > 0
          ? `Biaya admin ${formatRupiah(jasa.serviceFeeAmount, { bare: true })}`
          : null,
      amount: formatRupiah(
        masuk ? -(jasa.passthroughAmount - jasa.serviceFeeAmount) : jasa.passthroughAmount + jasa.serviceFeeAmount,
        { bare: true },
      ),
    })
  }

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

  const passthrough = source.passthroughTotal ?? 0
  if (passthrough !== 0) {
    totals.push({
      label: passthrough > 0 ? 'Titipan jasa' : 'Diserahkan ke pelanggan',
      value: formatRupiah(passthrough, { bare: true }),
    })
  }

  // Yang dicetak besar adalah UANG YANG BERPINDAH, bukan omzet. Untuk keranjang
  // barang saja keduanya sama. Untuk jasa tidak, dan struk yang menuliskan omzet
  // akan menagih pelanggan Rp 2.500 untuk token Rp 100.000.
  const dibayar = source.netTotal + passthrough
  totals.push({
    label: dibayar < 0 ? 'DISERAHKAN' : 'TOTAL',
    value: formatRupiah(Math.abs(dibayar), { bare: true }),
    emphasis: true,
  })

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
