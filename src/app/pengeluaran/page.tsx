import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { listExpenses } from '@/lib/expense/service'
import { getSetting } from '@/lib/settings'
import { findOpenShift } from '@/lib/shift/service'
import { ExpenseClient, type ExpenseRow } from './expense-client'

export const dynamic = 'force-dynamic'

export default async function PengeluaranPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')

  const shift = await findOpenShift(session.id)
  const expenses = shift ? await listExpenses(shift.id) : []
  const kategoriList = await getSetting('expenseCategories')

  const rows: ExpenseRow[] = expenses.map((e) => ({
    id: e.id,
    kategori: e.kategori,
    amount: e.amount,
    note: e.note,
    paidFrom: e.paidFrom,
    createdAt: e.createdAt.toISOString(),
  }))

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-lg p-4">
        <h1 className="mb-4 text-xl font-semibold text-kasir-text">Pengeluaran</h1>
        <ExpenseClient
          hasOpenShift={shift !== null}
          initialExpenses={rows}
          kategoriList={kategoriList}
        />
      </main>
    </>
  )
}
