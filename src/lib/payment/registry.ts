import type { Db } from '../audit'
import { prisma } from '../db/prisma'
import { PaymentStatusSchema, type PaymentMethod } from '../enums'
import { NotFoundError } from '../errors'
import { getSetting, type SettingKey } from '../settings'
import type { PaymentProvider, ProviderDeps } from './provider'
import { createCashProvider } from './providers/cash'
import { createStaticQrisProvider } from './providers/qris-static'

/**
 * Registry provider pembayaran.
 *
 * Referensi: docs/qris.md §5 langkah 2
 *
 * Menambah provider dinamis nanti = satu baris di `providersFor()` plus satu
 * nilai di `PAYMENT_METHODS`. Tidak ada kode transaksi, keranjang, laporan, atau
 * struk yang ikut berubah.
 */

export function providerDeps(db: Db = prisma): ProviderDeps {
  return {
    readSetting: <K extends SettingKey>(key: K) => getSetting(key, db),

    readStoredStatus: async (paymentId) => {
      const row = await db.payment.findUnique({
        where: { id: paymentId },
        select: { status: true },
      })
      if (!row) return null
      const parsed = PaymentStatusSchema.safeParse(row.status)
      return parsed.success ? parsed.data : null
    },
  }
}

/**
 * `Record<PaymentMethod, PaymentProvider>` dipilih dengan sengaja: menambahkan
 * metode pembayaran di `enums.ts` tanpa menulis providernya menjadi ERROR
 * KOMPILASI di sini, bukan kegagalan runtime di depan pelanggan.
 */
export function providersFor(db: Db = prisma): Record<PaymentMethod, PaymentProvider> {
  const deps = providerDeps(db)
  return {
    CASH: createCashProvider(deps),
    QRIS_STATIC: createStaticQrisProvider(deps),
  }
}

export function providerForMethod(method: PaymentMethod, db: Db = prisma): PaymentProvider {
  return providersFor(db)[method]
}

export function providerByName(name: string, db: Db = prisma): PaymentProvider {
  const found = Object.values(providersFor(db)).find((p) => p.name === name)
  if (!found) throw new NotFoundError(`Provider pembayaran tidak dikenal: ${name}`)
  return found
}

export function listProviders(db: Db = prisma): PaymentProvider[] {
  return Object.values(providersFor(db))
}
