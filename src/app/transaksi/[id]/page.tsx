import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { getVoidInfo } from '@/lib/transaction/service'
import { TransactionDetail, type DetailItem, type DetailRefund } from './detail-client'

export const dynamic = 'force-dynamic'

export default async function TransaksiDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')

  const { id } = await params

  const trx = await prisma.transaction.findUnique({
    where: { id },
    include: {
      items: { orderBy: { productName: 'asc' } },
      payments: true,
      cashier: { select: { name: true } },
      shift: { select: { status: true } },
      refunds: { include: { items: true }, orderBy: { createdAt: 'desc' } },
    },
  })

  if (!trx) {
    return (
      <>
        <Nav role={session.role} userName={session.name} />
        <main className="mx-auto w-full max-w-2xl p-4">
          <p className="text-sm text-kasir-danger">Transaksi tidak ditemukan.</p>
        </main>
      </>
    )
  }

  // Kelayakan void dihitung SERVER dan dikirim beserta alasannya, sehingga
  // penjelasan di layar tidak mungkin menyimpang dari yang ditegakkan endpoint.
  const voidInfo = await getVoidInfo(id)

  const items: DetailItem[] = trx.items.map((i) => ({
    id: i.id,
    productName: i.productName,
    qty: i.qty,
    unitPrice: i.unitPrice,
    lineFinal: i.lineFinal,
    refundedQty: i.refundedQty,
    refundedAmount: i.refundedAmount,
  }))

  const refunds: DetailRefund[] = trx.refunds.map((r) => ({
    id: r.id,
    refundNumber: r.refundNumber,
    amount: r.amount,
    method: r.method,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }))

  const payment = trx.payments[0]

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-2xl p-4">
        <TransactionDetail
          transactionId={trx.id}
          trxNumber={trx.trxNumber}
          status={trx.status}
          cashierName={trx.cashier.name}
          createdAt={trx.createdAt.toISOString()}
          grossSubtotal={trx.grossSubtotal}
          itemDiscountTotal={trx.itemDiscountTotal}
          transactionDiscount={trx.transactionDiscount}
          netTotal={trx.netTotal}
          paymentMethod={payment?.method ?? 'CASH'}
          paymentStatus={payment?.status ?? 'PENDING'}
          voidReason={trx.voidReason}
          items={items}
          refunds={refunds}
          canVoid={voidInfo.canVoid}
          voidBlockedReason={voidInfo.voidBlockedReason}
          needsManualRefund={voidInfo.needsManualRefund}
        />
      </main>
    </>
  )
}
