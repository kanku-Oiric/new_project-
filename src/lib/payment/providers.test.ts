import { describe, expect, it } from 'vitest'
import { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentStatus } from '../enums'
import type { SettingKey, SettingValue } from '../settings'
import { settlesImmediately } from './index'
import type { PaymentProvider, ProviderDeps } from './provider'
import { createCashProvider } from './providers/cash'
import { createCashOutProvider } from './providers/cash-out'
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
  statuses?: Record<string, PaymentStatus>
}): ProviderDeps {
  const values: Partial<Record<SettingKey, unknown>> = {
    qrisEnabled: opts.qrisEnabled ?? false,
  }
  return {
    readSetting: async <K extends SettingKey>(key: K) => values[key] as SettingValue<K>,
    readStoredStatus: async (paymentId) => opts.statuses?.[paymentId] ?? null,
  }
}

describe('QRIS soundbox — kesiapan', () => {
  it('belum siap kalau QRIS dimatikan', async () => {
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: false }))
    const readiness = await p.describe()

    expect(readiness.configured).toBe(false)
    expect(await p.isConfigured()).toBe(false)
    expect(readiness.label).toBe(QRIS_STATIC_INACTIVE_LABEL)
    expect(readiness.hint).toMatch(/Pengaturan/i)
  })

  it('siap begitu dinyalakan — tanpa syarat gambar QR', async () => {
    // Syarat "gambar QR harus ada" dulu memang ditegakkan di sini, dan test ini
    // dulu menguji kebalikannya. Ia dibalik, bukan dihapus: yang berubah adalah
    // kenyataan tokonya — QR-nya tertempel di meja, tidak pernah ditampilkan di
    // layar, jadi tidak ada gambar yang bisa diunggah maupun diperiksa.
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: true }))
    const readiness = await p.describe()

    expect(readiness.configured).toBe(true)
    expect(readiness.label).toBe(QRIS_STATIC_ACTIVE_LABEL)
    expect(readiness.hint).toBeNull()
  })

  it('labelnya tidak pernah mengklaim terintegrasi atau otomatis', async () => {
    // docs/qris.md §3.2 larangan ketiga. Kalimatnya tinggal di provider supaya
    // tidak ada halaman yang bisa menuliskan versi yang lebih berani.
    //
    // Kata "otomatis" tetap dilarang walaupun langkahnya kini satu: yang
    // menyelesaikan transaksi tetap MANUSIA yang menekan tombol setelah
    // mendengar bunyi. Sistem ini tidak pernah tahu sendiri uangnya masuk.
    for (const enabled of [true, false]) {
      const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: enabled }))
      const { label, hint } = await p.describe()
      const text = `${label} ${hint ?? ''}`
      expect(text).not.toMatch(/terintegrasi|tersambung|otomatis/i)
    }
  })
})

describe('QRIS soundbox — tetap tidak punya wewenang melunaskan sendiri', () => {
  it('createPayment tidak menghasilkan apa pun dan tidak menghubungi siapa pun', async () => {
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: true }))
    const created = await p.createPayment({ amount: 25_000, transactionId: 'trx-1' })

    // QR statis tidak dibuat per transaksi, jadi tidak ada externalId maupun
    // qrPayload — dan tidak ada panggilan jaringan yang bisa gagal saat internet
    // toko mati.
    expect(created).toEqual({})
  })

  it('checkStatus mengembalikan status TERSIMPAN apa adanya, untuk kelima state', async () => {
    for (const stored of PAYMENT_STATUSES) {
      const p = createStaticQrisProvider(
        fakeDeps({ qrisEnabled: true, statuses: { 'pay-1': stored } }),
      )
      expect(await p.checkStatus({ paymentId: 'pay-1', externalId: null })).toBe(stored)
    }
  })

  it('checkStatus tidak pernah memajukan PENDING menjadi PAID', async () => {
    // Masih berlaku, dan justru makin penting: baris PENDING sekarang hanya
    // lahir dari provider dinamis nanti, dan satu-satunya yang boleh
    // memajukannya adalah settleTransaction lewat gerbang di database.
    const p = createStaticQrisProvider(
      fakeDeps({ qrisEnabled: true, statuses: { 'pay-1': 'PENDING' } }),
    )

    for (let i = 0; i < 50; i++) {
      expect(await p.checkStatus({ paymentId: 'pay-1', externalId: null })).toBe('PENDING')
    }
  })

  it('pembayaran yang tidak dikenal menghasilkan null, bukan tebakan', async () => {
    const p = createStaticQrisProvider(fakeDeps({ qrisEnabled: true }))
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

describe('provider serah tunai', () => {
  it('selalu siap — tidak ada yang perlu dikonfigurasi untuk menyerahkan uang', async () => {
    const p = createCashOutProvider(fakeDeps({}))
    expect(await p.isConfigured()).toBe(true)
    expect(p.settlesOnCreate).toBe(true)
    expect(p.method).toBe('CASH_OUT')
  })
})

describe('konsistensi antara modul murni dan provider', () => {
  it('settlesOnCreate provider cocok dengan settlesImmediately(method)', async () => {
    const deps = fakeDeps({ qrisEnabled: true })
    const providers: PaymentProvider[] = [
      createCashProvider(deps),
      createStaticQrisProvider(deps),
      createCashOutProvider(deps),
    ]

    // Dua sumber yang harus sepakat: modul murni yang dipakai checkout untuk
    // memutuskan apakah langsung melunaskan, dan provider yang dilihat UI.
    // Kalau keduanya menyimpang, transaksi bisa berhenti di PENDING tanpa ada
    // layar yang bisa menyelesaikannya — persis transaksi terlantar yang dulu
    // harus dibersihkan auto-cancel saat tutup shift.
    for (const p of providers) {
      expect(p.settlesOnCreate).toBe(settlesImmediately(p.method))
    }
    expect(providers.map((p) => p.method)).toEqual(['CASH', 'QRIS_STATIC', 'CASH_OUT'])
  })

  it('setiap metode pembayaran yang terdaftar punya providernya', () => {
    // Bukan pemeriksaan kosong: `providersFor` mengembalikan
    // Record<PaymentMethod, PaymentProvider>, jadi metode tanpa provider adalah
    // error kompilasi. Test ini menjaga daftarnya tetap utuh saat seseorang
    // menambah metode lalu menambahkan `as` untuk membungkam compiler.
    expect([...PAYMENT_METHODS].sort()).toEqual(['CASH', 'CASH_OUT', 'QRIS_STATIC'])
  })
})
