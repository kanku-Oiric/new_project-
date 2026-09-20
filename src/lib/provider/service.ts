import 'server-only'
import { recordAudit, type AuditActor } from '../audit'
import { config } from '../config'
import { isUniqueViolation } from '../db/errors'
import { prisma } from '../db/prisma'
import { applyProviderMovement } from '../db/provider-balance'
import { ProviderKindSchema } from '../enums'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { fingerprint } from '../idempotency-server'
import { toBusinessDate } from '../time'

/**
 * Saldo provider — akun uang yang terpisah dari laci kas.
 *
 * Referensi: docs/architecture.md §21.3, docs/reporting.md §9.2
 *
 * Ini bukan inventori. Saldo Shopee/GoPay milik toko adalah UANG, hanya saja
 * duduknya di aplikasi lain dan tidak ada API yang bisa ditanyai berapa isinya.
 * Karena itu dua hal wajib ada dan keduanya ada di sini: setiap pergerakan
 * meninggalkan jejak dengan saldo sebelum dan sesudahnya, dan ada jalan resmi
 * untuk menyesuaikan angka tercatat terhadap angka asli di aplikasinya.
 *
 * Top-up dari laci ke provider adalah PERPINDAHAN KANTONG, bukan pengeluaran.
 * Ia tidak pernah muncul di laporan pengeluaran dan tidak mengurangi laba — tapi
 * ia memang mengurangi uang di laci, jadi ia masuk ke expectedCash sebagai
 * sukunya sendiri. Kalau ia dicatat sebagai pengeluaran, laba toko akan terlihat
 * anjlok setiap kali pemilik mengisi saldo.
 */

export interface ProviderActor extends AuditActor {
  userId: string
}

export interface ProviderRow {
  id: string
  nama: string
  jenis: string
  saldo: number
  urutan: number
  aktif: boolean
}

export async function listServiceProviders(includeInactive = false): Promise<ProviderRow[]> {
  return prisma.serviceProvider.findMany({
    where: includeInactive ? {} : { aktif: true },
    orderBy: [{ urutan: 'asc' }, { nama: 'asc' }],
    select: { id: true, nama: true, jenis: true, saldo: true, urutan: true, aktif: true },
  })
}

export async function createServiceProvider(
  actor: ProviderActor,
  input: { nama: string; jenis: string; saldoAwal: number; urutan?: number },
  now: Date = new Date(),
): Promise<ProviderRow> {
  const jenis = ProviderKindSchema.parse(input.jenis)
  const nama = input.nama.trim()

  if (nama === '') throw new ValidationError('Nama provider wajib diisi')
  if (!Number.isInteger(input.saldoAwal) || input.saldoAwal < 0) {
    throw new ValidationError('Saldo awal harus bilangan bulat rupiah, minimal 0')
  }

  return prisma.$transaction(async (tx) => {
    const provider = await tx.serviceProvider.create({
      data: { nama, jenis, urutan: input.urutan ?? 0, saldo: 0 },
    })

    if (input.saldoAwal > 0) {
      // Lewat applyProviderMovement supaya invarian "saldo == Σ amountChange"
      // berlaku sejak baris pertama, bukan baru setelah top-up pertama.
      await applyProviderMovement(tx, {
        providerId: provider.id,
        amountChange: input.saldoAwal,
        reason: 'INITIAL',
        refType: 'MANUAL',
        userId: actor.userId,
        businessDate: toBusinessDate(now, config.timezone),
        note: 'Saldo awal saat provider dibuat',
      })
    }

    await recordAudit(tx, actor, {
      action: 'PROVIDER_CREATE',
      summary: `Provider ${nama} dibuat, saldo awal ${input.saldoAwal}`,
      entityType: 'ServiceProvider',
      entityId: provider.id,
      after: { nama, jenis, saldoAwal: input.saldoAwal },
    })

    return {
      id: provider.id,
      nama,
      jenis,
      saldo: input.saldoAwal,
      urutan: provider.urutan,
      aktif: provider.aktif,
    }
  })
}

export interface ProviderMovementInputApi {
  amount: number
  /** Hanya untuk top-up: dari laci kas atau dari luar laci. */
  paidFrom?: string
  note?: string
  idempotencyKey: string
  shiftId?: string
}

export interface ProviderMovementResultApi {
  providerId: string
  providerName: string
  balanceBefore: number
  balanceAfter: number
  amountChange: number
  replayed: boolean
}

function movementFingerprint(
  providerId: string,
  reason: string,
  amountChange: number,
  extra: Record<string, unknown>,
): string {
  return fingerprint({ providerId, reason, amountChange, ...extra })
}

/**
 * Baca pergerakan yang kuncinya sudah pernah dipakai. `null` = belum pernah.
 *
 * Alasannya sama seperti di checkout dan pengeluaran: top-up saldo yang tercatat
 * dua kali berarti laci toko dianggap berkurang dua kali, dan kasirnya yang
 * tampak kehilangan uang.
 */
async function readMovementByKey(
  key: string,
  expectedFingerprint: string,
  actorUserId: string,
): Promise<ProviderMovementResultApi | null> {
  const movement = await prisma.providerBalanceMovement.findUnique({
    where: { idempotencyKey: key },
    include: { provider: { select: { nama: true } } },
  })
  if (!movement) return null

  if (movement.idempotencyFingerprint !== expectedFingerprint) {
    throw new ConflictError(
      'Kunci ini sudah dipakai untuk pergerakan saldo yang berbeda. Muat ulang halaman saldo sebelum mengulang.',
    )
  }
  if (movement.userId !== actorUserId) {
    throw new ConflictError('Kunci pergerakan saldo ini milik pengguna lain.')
  }

  return {
    providerId: movement.providerId,
    providerName: movement.provider.nama,
    balanceBefore: movement.balanceBefore,
    balanceAfter: movement.balanceAfter,
    amountChange: movement.amountChange,
    replayed: true,
  }
}

function requireKey(key: string, operasi: string): void {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ValidationError(`idempotencyKey wajib diisi untuk ${operasi}`)
  }
}

/**
 * Isi saldo provider dari laci kas (atau dari luar laci).
 *
 * `paidFrom = CASH_DRAWER` adalah yang menyentuh rekonsiliasi kas. Yang lain
 * (transfer dari rekening pribadi pemilik, misalnya) tetap menaikkan saldo tapi
 * tidak mengurangi laci.
 */
export async function topupProvider(
  actor: ProviderActor,
  providerId: string,
  input: ProviderMovementInputApi,
  now: Date = new Date(),
): Promise<ProviderMovementResultApi> {
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new ValidationError('Nominal top-up harus bilangan bulat rupiah, minimal 1')
  }
  requireKey(input.idempotencyKey, 'mencatat top-up saldo')

  const paidFrom = input.paidFrom === 'OTHER' ? 'OTHER' : 'CASH_DRAWER'
  const print = movementFingerprint(providerId, 'TOPUP', input.amount, {
    paidFrom,
    note: input.note?.trim() || null,
  })

  const sudahAda = await readMovementByKey(input.idempotencyKey, print, actor.userId)
  if (sudahAda) return sudahAda

  try {
    return await prisma.$transaction(async (tx) => {
      const provider = await tx.serviceProvider.findUnique({ where: { id: providerId } })
      if (!provider) throw new NotFoundError('Provider tidak ditemukan')

      const moved = await applyProviderMovement(tx, {
        providerId,
        amountChange: input.amount,
        reason: 'TOPUP',
        paidFrom,
        refType: 'MANUAL',
        userId: actor.userId,
        shiftId: input.shiftId,
        businessDate: toBusinessDate(now, config.timezone),
        note: input.note?.trim() || undefined,
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: print,
      })

      await recordAudit(tx, actor, {
        action: 'PROVIDER_TOPUP',
        summary: `Top-up ${provider.nama} ${input.amount} (${paidFrom === 'CASH_DRAWER' ? 'dari laci' : 'dari luar laci'})`,
        entityType: 'ServiceProvider',
        entityId: providerId,
        before: { saldo: moved.balanceBefore },
        after: { saldo: moved.balanceAfter, paidFrom, note: input.note ?? null },
      })

      return {
        providerId,
        providerName: provider.nama,
        balanceBefore: moved.balanceBefore,
        balanceAfter: moved.balanceAfter,
        amountChange: moved.amountChange,
        replayed: false,
      }
    })
  } catch (e) {
    if (isUniqueViolation(e)) {
      const lagi = await readMovementByKey(input.idempotencyKey, print, actor.userId)
      if (lagi) return lagi
    }
    throw e
  }
}

/**
 * Sesuaikan saldo tercatat terhadap saldo ASLI di aplikasi provider.
 *
 * Setara opname untuk stok, dan wajib PIN pemilik (diverifikasi di route):
 * yang diubah di sini adalah angka uang, dan tidak ada bukti di dalam sistem
 * yang bisa membenarkannya — buktinya ada di layar aplikasi Shopee.
 *
 * `newBalance` adalah angka yang dibaca pemilik di aplikasi; selisihnya yang
 * dicatat sebagai pergerakan, supaya riwayatnya tetap bisa dijumlahkan.
 */
export async function adjustProviderBalance(
  actor: ProviderActor & { authorizedByUserId: string },
  providerId: string,
  input: { newBalance: number; note?: string; idempotencyKey: string },
  now: Date = new Date(),
): Promise<ProviderMovementResultApi> {
  if (!Number.isInteger(input.newBalance)) {
    throw new ValidationError('Saldo asli harus bilangan bulat rupiah')
  }
  requireKey(input.idempotencyKey, 'mencatat penyesuaian saldo')

  const provider = await prisma.serviceProvider.findUnique({ where: { id: providerId } })
  if (!provider) throw new NotFoundError('Provider tidak ditemukan')

  const selisih = input.newBalance - provider.saldo
  if (selisih === 0) {
    throw new ValidationError('Saldo tercatat sudah sama dengan saldo yang dimasukkan')
  }

  // Sidik jarinya memakai `newBalance` — ANGKA YANG DIKETIK PEMILIK — bukan
  // selisih hasil hitungan. Selisih berubah setiap kali ada transaksi jasa, jadi
  // sidik jari dari selisih akan menolak pengulangan yang sah sebagai "isi
  // berbeda". Pelajaran yang sama seperti mode `newQty` pada penyesuaian stok.
  const print = movementFingerprint(providerId, 'ADJUSTMENT', 0, {
    newBalance: input.newBalance,
    note: input.note?.trim() || null,
  })

  const sudahAda = await readMovementByKey(input.idempotencyKey, print, actor.userId)
  if (sudahAda) return sudahAda

  try {
    return await prisma.$transaction(async (tx) => {
      const moved = await applyProviderMovement(tx, {
        providerId,
        amountChange: selisih,
        reason: 'ADJUSTMENT',
        refType: 'MANUAL',
        userId: actor.userId,
        businessDate: toBusinessDate(now, config.timezone),
        note: input.note?.trim() || undefined,
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: print,
      })

      await recordAudit(tx, actor, {
        action: 'PROVIDER_ADJUSTMENT',
        summary: `Saldo ${provider.nama}: ${moved.balanceBefore} → ${moved.balanceAfter} (${selisih > 0 ? '+' : ''}${selisih})`,
        entityType: 'ServiceProvider',
        entityId: providerId,
        before: { saldo: moved.balanceBefore },
        after: {
          saldo: moved.balanceAfter,
          selisih,
          note: input.note ?? null,
          authorizedByUserId: actor.authorizedByUserId,
        },
      })

      return {
        providerId,
        providerName: provider.nama,
        balanceBefore: moved.balanceBefore,
        balanceAfter: moved.balanceAfter,
        amountChange: selisih,
        replayed: false,
      }
    })
  } catch (e) {
    if (isUniqueViolation(e)) {
      const lagi = await readMovementByKey(input.idempotencyKey, print, actor.userId)
      if (lagi) return lagi
    }
    throw e
  }
}

export interface ProviderHistoryRow {
  id: string
  amountChange: number
  reason: string
  balanceBefore: number
  balanceAfter: number
  paidFrom: string | null
  note: string | null
  businessDate: string
  createdAt: Date
}

export async function providerHistory(
  providerId: string,
  take = 100,
): Promise<ProviderHistoryRow[]> {
  return prisma.providerBalanceMovement.findMany({
    where: { providerId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      amountChange: true,
      reason: true,
      balanceBefore: true,
      balanceAfter: true,
      paidFrom: true,
      note: true,
      businessDate: true,
      createdAt: true,
    },
  })
}
