import type { Prisma } from '@prisma/client'

/**
 * Nomor transaksi dan refund yang bisa dibaca manusia.
 *
 *   TRX-20260919-000123
 *   RFN-20260919-000045
 *
 * UUID tetap menjadi primary key; nomor ini hanya untuk ditampilkan dan
 * disebutkan pelanggan (docs/architecture.md §6.6).
 */

export type NumberPrefix = 'TRX' | 'RFN'

const SEQ_WIDTH = 6

/**
 * Ambil nomor urut berikutnya untuk satu hari usaha.
 *
 * Increment dilakukan dalam satu pernyataan SQL atomic, DI DALAM transaction
 * yang sama dengan pembuatan transaksinya. Membaca lalu menulis akan membuat
 * dua kasir yang checkout bersamaan mendapat nomor yang sama — dan karena
 * `trxNumber` unik, salah satunya gagal checkout tepat saat toko ramai.
 *
 * `@unique` pada trxNumber tetap dipasang sebagai jaring pengaman terakhir.
 */
export async function nextNumber(
  tx: Prisma.TransactionClient,
  prefix: NumberPrefix,
  businessDate: string,
): Promise<string> {
  const compact = businessDate.replace(/-/g, '')
  const scope = `${prefix}-${compact}`

  const rows = await tx.$queryRaw<{ lastSeq: number | bigint }[]>`
    INSERT INTO daily_counters (scope, lastSeq) VALUES (${scope}, 1)
    ON CONFLICT(scope) DO UPDATE SET lastSeq = lastSeq + 1
    RETURNING lastSeq
  `

  const row = rows[0]
  if (!row) throw new Error(`gagal mengambil nomor urut untuk ${scope}`)

  // SQLite mengembalikan integer sebagai BigInt lewat Prisma raw query.
  const seq = Number(row.lastSeq)
  return `${prefix}-${compact}-${String(seq).padStart(SEQ_WIDTH, '0')}`
}
