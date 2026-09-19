import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, parseQuery, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { ExpenseSourceSchema } from '@/lib/enums'
import { ConflictError } from '@/lib/errors'
import { createExpense, listExpenses } from '@/lib/expense/service'
import { findOpenShift } from '@/lib/shift/service'

export const dynamic = 'force-dynamic'

const ListSchema = z.object({ shiftId: z.string().uuid().optional() })

const CreateSchema = z.object({
  kategori: z.string().trim().min(1).max(60),
  amount: z.number().int().min(1).max(2_147_483_647),
  note: z.string().trim().max(500).optional(),
  paidFrom: ExpenseSourceSchema.default('CASH_DRAWER'),
})

export const GET = route('expenses.list', async (req) => {
  const session = await requireSession()
  const { shiftId } = parseQuery(req, ListSchema)

  const target = shiftId ?? (await findOpenShift(session.id))?.id
  if (!target) return ok({ expenses: [] })

  return ok({ expenses: await listExpenses(target) })
})

export const POST = route('expenses.create', async (req) => {
  const session = await requireSession()
  const body = await parseBody(req, CreateSchema)

  const shift = await findOpenShift(session.id)
  if (!shift) {
    throw new ConflictError('Belum ada shift terbuka. Buka shift dulu sebelum mencatat pengeluaran.')
  }

  const expense = await createExpense(
    { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
    { shiftId: shift.id, ...body },
  )
  return ok({ expense }, 201)
})
