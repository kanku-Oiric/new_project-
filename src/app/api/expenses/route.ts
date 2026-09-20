import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, parseQuery, route } from '@/lib/api'
import { requireSession } from '@/lib/auth/session'
import { ExpenseSourceSchema } from '@/lib/enums'
import { ConflictError } from '@/lib/errors'
import { createExpense, listExpenses } from '@/lib/expense/service'
import { IdempotencyKeySchema } from '@/lib/idempotency'
import { findOpenShift } from '@/lib/shift/service'

export const dynamic = 'force-dynamic'

const ListSchema = z.object({ shiftId: z.string().uuid().optional() })

const CreateSchema = z.object({
  kategori: z.string().trim().min(1).max(60),
  amount: z.number().int().min(1).max(2_147_483_647),
  note: z.string().trim().max(500).optional(),
  paidFrom: ExpenseSourceSchema.default('CASH_DRAWER'),
  // WAJIB. Pengeluaran yang tercatat dua kali menurunkan expected cash dua kali,
  // dan yang tampak kehilangan uang adalah kasirnya (src/lib/idempotency.ts).
  idempotencyKey: IdempotencyKeySchema,
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

  // Body di-parse LEBIH DULU, sebelum pemeriksaan bisnis apa pun — sama seperti
  // di /api/transactions. Request tanpa kunci harus dijawab 400 "kunci wajib",
  // bukan 409 "belum ada shift": dua pesan itu menuntun kasir ke dua tindakan
  // yang berbeda.
  const body = await parseBody(req, CreateSchema)

  const shift = await findOpenShift(session.id)
  if (!shift) {
    throw new ConflictError('Belum ada shift terbuka. Buka shift dulu sebelum mencatat pengeluaran.')
  }

  const result = await createExpense(
    { userId: session.id, role: session.role, ip: clientIp(req), deviceLabel: deviceLabel(req) },
    { shiftId: shift.id, ...body },
  )

  // 200, bukan 201: request ini tidak mencatat apa pun yang baru. Bedanya yang
  // memberi tahu kasir bahwa pengeluarannya sudah tersimpan sejak tadi.
  return ok(
    { expense: result.expense, replayed: result.replayed },
    result.replayed ? 200 : 201,
  )
})
