import { describe, expect, it } from 'vitest'
import { PAYMENT_STATUSES, type PaymentStatus } from '../enums'
import type { SettingKey, SettingValue } from '../settings'
import { settlesImmediately } from './index'
import type { PaymentProvider, ProviderDeps } from './provider'
import { createCashProvider } from './providers/cash'
import {
  QRIS_STATIC_ACTIVE_LABEL,
  QRIS_STATIC_INACTIVE_LABEL,
  createStaticQrisProvider,
} from './providers/qris-static'

/**
 * Provider diuji tanpa database dan tanpa jaringan, lewat dependensi palsu.
 * Itu sebabnya `ProviderDeps` ada: kalau providernya mengimpor prisma langsung,
 * pengujian keadaan "QRIS belum dikonfigurasi" butuh database.
 */
function fakeDeps(opts: {
  qrisEnabled?: boolean
  qrisImagePath?: string
  statuses?: Record<string, PaymentStatus>
}): ProviderDeps {
  const values: Partial<Record<SettingKey, unknown>> = {
    qrisEnabled: opts.qrisEnabled ?? false,
    qrisImagePath: opts.qrisImagePath ?? '',
  }
  return {
    readSetting: async <K extends SettingKey>(key: K) => values[key] as SettingValue<K>,
    readStoredStatus: async (paymentId) => opts.statuses?.[paymentId] ?? null,
  }
}

describe('StaticQrisProvider — kesiapan', () => {
  it('belum siap kalau QRIS dimatikan, walaupun gambarnya ada', async () => {
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: false, qrisImagePath: 'qr.png' }))
    const readiness = await p.describe()

    expect(readiness.configured).toBe(false)
    expect(await p.isConfigured()).toBe(false)
    expect(readiness.label).toBe(QRIS_STATIC_INACTIVE_LABEL)
    expect(readiness.hint).toMatch(/dimatikan/i)
  })

  it('belum siap kalau dinyalakan tanpa gambar QR', async () => {
    // Kalau ini lolos, kasir menekan "Bayar dengan QRIS" dan menghadap kotak
    // kosong sementara pelanggan menunggu.
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: true, qrisImagePath: '' }))
    const readiness = await p.describe()

    expect(readiness.configured).toBe(false)
    expect(readiness.hint).toMatch(/gambar QR belum diunggah/i)
  })

  it('siap hanya kalau dinyalakan DAN gambarnya ada', async () => {
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: true, qrisImagePath: 'qr.png' }))
    const readiness = await p.describe()

    expect(readiness.configured).toBe(true)
    expect(readiness.label).toBe(QRIS_STATIC_ACTIVE_LABEL)
    expect(readiness.hint).toBeNull()
  })

  it('labelnya menyebut konfirmasi manual, dan tidak pernah mengklaim terintegrasi', async () => {
    // docs/qris.md §3.2 larangan ketiga. Kalimatnya tinggal di provider supaya
    // tidak ada halaman yang bisa menuliskan versi yang lebih berani.
    expect(QRIS_STATIC_ACTIVE_LABEL).toMatch(/konfirmasi manual kasir/i)

    for (const enabled of [true, false]) {
      const p = createStaticQrisProvider(
        fakeDeps({ qrisEnabled: enabled, qrisImagePath: 'qr.png' }),
      )
      const { label, hint } = await p.describe()
      const text = `${label} ${hint ?? ''}`
      expect(text).not.toMatch(/terintegrasi|tersambung|otomatis/i)
    }
  })
})

describe('StaticQrisProvider — tidak punya wewenang melunaskan', () => {
  it('createPayment tidak menghasilkan apa pun dan tidak menghubungi siapa pun', async () => {
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: true, qrisImagePath: 'qr.png' }))
    const created = await p.createPayment({ amount: 25_000, transactionId: 'trx-1' })

    // QR statis tidak dibuat per transaksi, jadi tidak ada externalId maupun
    // qrPayload — dan tidak ada panggilan jaringan yang bisa gagal saat internet
    // toko mati.
    expect(created).toEqual({})
  })

  it('checkStatus mengembalikan status TERSIMPAN apa adanya, untuk kelima state', async () => {
    for (const stored of PAYMENT_STATUSES) {
      const p = createStaticQrisProvider(
        fakeDeps({ qrisEnabled: true, qrisImagePath: 'qr.png', statuses: { 'pay-1': stored } }),
      )
      expect(await p.checkStatus({ paymentId: 'pay-1', externalId: null })).toBe(stored)
    }
  })

  it('checkStatus tidak pernah memajukan PENDING menjadi PAID', async () => {
    const p = createStaticQrisProvider(
      fakeDeps({ qrisEnabled: true, qrisImagePath: 'qr.png', statuses: { 'pay-1': 'PENDING' } }),
    )

    // Dipanggil berkali-kali, sesering apa pun UI melakukannya.
    for (let i = 0; i < 50; i++) {
      expect(await p.checkStatus({ paymentId: 'pay-1', externalId: null })).toBe('PENDING')
    }
  })

  it('pembayaran yang tidak dikenal menghasilkan null, bukan tebakan', async () => {
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: true, qrisImagePath: 'qr.png' }))
    expect(await p.checkStatus({ paymentId: 'entah', externalId: null })).toBeNull()
  })
})

describe('provider tunai', () => {
  it('selalu siap dan selesai saat transaksi dibuat', async () => {
    const p = createCashProvider(fakeDeps({}))
    expect(await p.isConfigured()).toBe(true)
    expect(p.settlesOnCreate).toBe(true)
    expect((await p.describe()).configured).toBe(true)
  })
})

describe('konsistensi antara modul murni dan provider', () => {
  it('settlesOnCreate provider cocok dengan settlesImmediately(method)', async () => {
    const deps = fakeDeps({ qrisEnabled: true, qrisImagePath: 'qr.png' })
    const providers: PaymentProvider[] = [createCashProvider(deps), createStaticQrisProvider(deps)]

    // Dua sumber yang harus sepakat: modul murni yang dipakai checkout untuk
    // memutuskan apakah langsung melunaskan, dan provider yang dilihat UI.
    // Kalau keduanya menyimpang, QRIS bisa ikut lunas seketika.
    for (const p of providers) {
      expect(p.settlesOnCreate).toBe(settlesImmediately(p.method))
    }
    expect(providers.map((p) => p.method)).toEqual(['CASH', 'QRIS_STATIC'])
  })
})
