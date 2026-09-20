import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { config } from '@/lib/config'
import { prisma } from '@/lib/db/prisma'
import { buildReceipt, receiptPageWidth, type ReceiptWidth } from '@/lib/receipt'
import { getAllSettingsRaw } from '@/lib/settings'
import { AutoPrint } from './auto-print'

export const dynamic = 'force-dynamic'

/**
 * Tampilan struk print-friendly.
 *
 * Renderer HTML ini adalah satu-satunya bagian yang perlu diganti kalau nanti
 * ditambah driver thermal printer — `buildReceipt` yang menyusun isinya tetap
 * sama (docs/architecture.md §13).
 */
export default async function StrukPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ print?: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')

  const { id } = await params
  const { print } = await searchParams

  const transaction = await prisma.transaction.findUnique({
    where: { id },
    include: {
      items: { orderBy: { productName: 'asc' } },
      services: true,
      payments: { orderBy: { createdAt: 'asc' } },
      cashier: { select: { name: true } },
    },
  })

  if (!transaction) {
    return (
      <main className="p-8 text-center">
        <p className="text-sm text-kasir-danger">Transaksi tidak ditemukan.</p>
      </main>
    )
  }

  const settings = await getAllSettingsRaw()
  const payment = transaction.payments[0]

  const model = buildReceipt(
    {
      trxNumber: transaction.trxNumber,
      createdAt: transaction.completedAt ?? transaction.createdAt,
      cashierName: transaction.cashier.name,
      items: transaction.items,
      services: transaction.services,
      grossSubtotal: transaction.grossSubtotal,
      itemDiscountTotal: transaction.itemDiscountTotal,
      transactionDiscount: transaction.transactionDiscount,
      netTotal: transaction.netTotal,
      passthroughTotal: transaction.passthroughTotal,
      paymentMethod: payment?.method ?? 'CASH',
      amountTendered: payment?.amountTendered ?? null,
      changeAmount: payment?.changeAmount ?? null,
      status: transaction.status,
    },
    {
      name: settings.storeName,
      address: settings.storeAddress,
      phone: settings.storePhone,
      footer: settings.receiptFooter,
    },
    config.timezone,
  )

  const width = receiptPageWidth((settings.receiptWidth as ReceiptWidth) ?? '80')

  return (
    <>
      <style>{`
        @page { size: ${width} auto; margin: 4mm; }
        @media print {
          html, body { background: #fff; }
          .struk { width: auto; border: 0; margin: 0; padding: 0; }
        }
      `}</style>

      {print === '1' && <AutoPrint />}

      <main className="min-h-dvh bg-kasir-bg p-4 print:bg-white print:p-0">
        <div
          className="struk mx-auto border border-kasir-border bg-white p-4 font-mono text-[12px] leading-tight text-black"
          style={{ width, maxWidth: '100%' }}
        >
          <header className="text-center">
            <p className="text-[14px] font-bold">{model.store.name}</p>
            {model.store.address && <p>{model.store.address}</p>}
            {model.store.phone && <p>{model.store.phone}</p>}
          </header>

          {model.draftNotice && (
            <p className="my-2 text-center font-bold">{model.draftNotice}</p>
          )}

          <Divider />

          <div className="flex justify-between">
            <span>{model.trxNumber}</span>
          </div>
          <div className="flex justify-between">
            <span>
              {model.dateLabel} {model.timeLabel}
            </span>
            <span>{model.cashierName}</span>
          </div>

          <Divider />

          <ul>
            {model.lines.map((line, i) => (
              <li key={i} className="mb-1">
                <p>{line.name}</p>
                <div className="flex justify-between">
                  <span>{line.qtyPrice}</span>
                  <span>{line.amount}</span>
                </div>
                {line.discountLabel && (
                  <p className="pl-2 text-[11px]">{line.discountLabel}</p>
                )}
              </li>
            ))}
          </ul>

          <Divider />

          <dl>
            {model.totals.map((row, i) => (
              <div
                key={i}
                className={`flex justify-between ${row.emphasis ? 'text-[14px] font-bold' : ''}`}
              >
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          <Divider />

          <p className="text-center">{model.paymentLabel}</p>
          <p className="mt-2 text-center">{model.footer}</p>
        </div>

        <div className="no-print mx-auto mt-4 flex max-w-sm gap-2">
          <a
            href="/kasir"
            className="flex h-12 flex-1 items-center justify-center rounded-xl border border-kasir-border bg-kasir-surface text-sm"
          >
            Kembali ke kasir
          </a>
          <a
            href={`/struk/${transaction.id}?print=1`}
            className="flex h-12 flex-1 items-center justify-center rounded-xl bg-kasir-accent text-sm font-medium text-white"
          >
            Cetak
          </a>
        </div>
      </main>
    </>
  )
}

function Divider() {
  return <p className="my-1 select-none overflow-hidden whitespace-nowrap">{'-'.repeat(48)}</p>
}
