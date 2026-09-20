import type { Prisma } from '@prisma/client'
import type { ExpenseSource, ProviderMovementReason } from '../enums'
import { ConflictError, ValidationError } from '../errors'
import { MAX_RUPIAH_COLUMN } from '../money'

/**
 * Pergerakan saldo provider.
 *
 * Ini SATU-SATUNYA jalan `service_providers.saldo` boleh berubah — persis
 * seperti `applyStockMovement` untuk `products.stok`. Tidak ada UPDATE saldo
 * langsung di tempat lain, sehingga setiap perubahan pasti meninggalkan jejak
 * di `provider_balance_movements` (docs/architecture.md §21.3).
 *
 * Saldo provider adalah UANG, bukan angka inventori. Ia duduk di aplikasi
 * Shopee/GoPay milik toko, terpisah dari laci kas, dan tidak ada API yang bisa
 * ditanyai berapa isinya. Yang membuatnya bisa dipercaya hanya dua hal: setiap
 * pergerakan tercatat dengan saldo sebelum dan sesudahnya, dan rekonsiliasi
 * manual terhadap aplikasi aslinya.
 */

export interface ProviderMovementInput {
  providerId: string
  /** BERTANDA: positif = saldo masuk (top-up, tarik tunai), negatif = keluar. */
  amountChange: number
  reason: ProviderMovementReason
  userId: string
  businessDate: string
  /** Hanya untuk TOPUP: menentukan apakah expected cash shift ikut berkurang. */
  paidFrom?: ExpenseSource
  refType?: 'TRANSACTION' | 'MANUAL'
  refId?: string
  shiftId?: string
  note?: string
  idempotencyKey?: string
  idempotencyFingerprint?: string
}

export interface ProviderMovementResult {
  providerId: string
  balanceBefore: number
  balanceAfter: number
  amountChange: number
}

/**
 * Tambah/kurangi saldo secara ATOMIC lalu catat pergerakannya.
 *
 * Perubahan dilakukan lewat raw SQL `SET saldo = saldo + ?`, bukan baca-lalu-
 * tulis. Alasannya sama persis seperti stok, dan di sini taruhannya uang:
 *
 *   Kasir A: baca saldo=500.000 → hitung 500.000−100.000 → tulis 400.000
 *   Kasir B: baca saldo=500.000 → hitung 500.000−100.000 → tulis 400.000
 *   Hasil: dua token terjual, saldo cuma turun sekali ← Rp 100.000 hilang
 *
 * Saldo boleh menjadi NEGATIF, dan itu keputusan yang sama seperti stok minus:
 * menolak penjualan nyata karena angka saldo yang mungkin sudah tidak akurat
 * lebih merugikan daripada mencatat saldo minus dan memperingatkannya. Saldo
 * minus muncul di halaman saldo dan di laporan sebagai hal yang harus diperiksa.
 */
export async function applyProviderMovement(
  tx: Prisma.TransactionClient,
  input: ProviderMovementInput,
): Promise<ProviderMovementResult> {
  if (!Number.isInteger(input.amountChange) || input.amountChange === 0) {
    throw new Error(`amountChange harus bilangan bulat bukan nol, dapat ${input.amountChange}`)
  }

  // Batas kolom dijaga DI DALAM SQL, bukan sesudah UPDATE berjalan.
  //
  // Alasannya ditemukan dengan menjalankannya: SQLite menyimpan integer 64-bit
  // dan menerima `saldo + 2.1 miliar` tanpa mengeluh, tapi `RETURNING saldo`
  // kemudian harus dikembalikan Prisma sebagai kolom `Int` — dan konversi
  // itulah yang meledak. Artinya pemeriksaan apa pun SETELAH query ini tidak
  // pernah sempat berjalan, dan pemanggilnya menerima kegagalan Prisma yang
  // keluar sebagai 500.
  //
  // Lebih buruk lagi di luar transaction: UPDATE-nya sudah commit, jadi
  // barisnya tersimpan dengan nilai yang TIDAK BISA DIBACA Prisma lagi —
  // `findUnique` pada provider itu ikut gagal selamanya. Di dalam
  // `$transaction` ia memang ter-rollback, tapi menggantungkan keutuhan data
  // pada "kebetulan pemanggilnya membungkus transaction" bukan penjagaan.
  //
  // Dengan syarat di WHERE, baris yang akan melampaui batas TIDAK PERNAH
  // ditulis, dan yang kembali adalah nol baris.
  const rows = await tx.$queryRaw<{ saldo: number | bigint }[]>`
    UPDATE service_providers SET saldo = saldo + ${input.amountChange}
    WHERE id = ${input.providerId}
      AND saldo + ${input.amountChange} BETWEEN ${-MAX_RUPIAH_COLUMN} AND ${MAX_RUPIAH_COLUMN}
    RETURNING saldo
  `

  const row = rows[0]
  if (!row) {
    // Nol baris berarti salah satu dari dua hal, dan keduanya butuh jawaban
    // yang berbeda bagi manusia yang menekan tombolnya.
    const ada = await tx.serviceProvider.findUnique({
      where: { id: input.providerId },
      select: { id: true },
    })

    if (ada) {
      // Bukan kekhawatiran teoretis: pemilik yang mengetik 2000000000 alih-alih
      // 2000000 menemui persis jalur ini, dan yang ia butuhkan adalah kalimat
      // yang menyebut sebabnya — bukan "terjadi kesalahan di server".
      throw new ValidationError(
        `Saldo provider akan melewati batas kolom (±${MAX_RUPIAH_COLUMN}) setelah pergerakan ${input.amountChange}. Periksa jumlah nolnya.`,
      )
    }

    // Provider hilang di tengah transaksi (dinonaktifkan/dihapus bersamaan).
    // Melempar di sini me-rollback seluruh checkout, yang memang benar: lebih
    // baik penjualannya gagal daripada titipan tercatat tanpa saldo bergerak.
    throw new ConflictError('Provider tidak ditemukan saat memperbarui saldo')
  }

  // SQLite mengembalikan integer sebagai BigInt lewat Prisma raw query.
  const balanceAfter = Number(row.saldo)
  const balanceBefore = balanceAfter - input.amountChange

  await tx.providerBalanceMovement.create({
    data: {
      providerId: input.providerId,
      amountChange: input.amountChange,
      reason: input.reason,
      balanceBefore,
      balanceAfter,
      paidFrom: input.paidFrom ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      userId: input.userId,
      shiftId: input.shiftId ?? null,
      note: input.note ?? null,
      businessDate: input.businessDate,
      idempotencyKey: input.idempotencyKey ?? null,
      idempotencyFingerprint: input.idempotencyFingerprint ?? null,
    },
  })

  return {
    providerId: input.providerId,
    balanceBefore,
    balanceAfter,
    amountChange: input.amountChange,
  }
}
