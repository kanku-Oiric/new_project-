import { describe, expect, it } from 'vitest'
import { PAYMENT_STATUSES, type PaymentStatus } from '../enums'
import {
  PaymentError,
  assertCashSufficient,
  assertTransition,
  calculateCash,
  canTransition,
  quickCashOptions,
  settlesImmediately,
} from './index'

describe('canTransition — state machine pembayaran', () => {
  it('PENDING boleh menuju keempat state terminal', () => {
    expect(canTransition('PENDING', 'PAID')).toBe(true)
    expect(canTransition('PENDING', 'EXPIRED')).toBe(true)
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true)
    expect(canTransition('PENDING', 'FAILED')).toBe(true)
  })

  it('state terminal tidak punya transisi keluar, tanpa pengecualian', () => {
    const terminals: PaymentStatus[] = ['PAID', 'EXPIRED', 'CANCELLED', 'FAILED']
    for (const from of terminals) {
      for (const to of PAYMENT_STATUSES) {
        expect(canTransition(from, to)).toBe(false)
      }
    }
  })

  it('PAID → PAID ditolak, sehingga double-confirm tidak pernah sah', () => {
    expect(canTransition('PAID', 'PAID')).toBe(false)
  })

  it('tidak bisa kembali ke PENDING dari mana pun', () => {
    for (const from of PAYMENT_STATUSES) {
      expect(canTransition(from, 'PENDING')).toBe(false)
    }
  })

  it('seluruh 25 kombinasi terdefinisi, hanya 4 yang sah', () => {
    let allowed = 0
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (canTransition(from, to)) allowed++
      }
    }
    expect(PAYMENT_STATUSES.length * PAYMENT_STATUSES.length).toBe(25)
    expect(allowed).toBe(4)
  })

  it('assertTransition melempar untuk transisi tidak sah', () => {
    expect(() => assertTransition('PENDING', 'PAID')).not.toThrow()
    expect(() => assertTransition('PAID', 'CANCELLED')).toThrow(PaymentError)
    expect(() => assertTransition('CANCELLED', 'PAID')).toThrow(PaymentError)
  })
})

describe('settlesImmediately', () => {
  it('tunai selesai seketika, QRIS statis tidak', () => {
    expect(settlesImmediately('CASH')).toBe(true)
    // Tidak boleh ada jalur yang menandai QRIS statis lunas tanpa aksi manusia.
    expect(settlesImmediately('QRIS_STATIC')).toBe(false)
  })
})

describe('calculateCash', () => {
  it('menghitung kembalian', () => {
    const c = calculateCash(48_500, 100_000)
    expect(c.sufficient).toBe(true)
    expect(c.changeAmount).toBe(51_500)
    expect(c.shortfall).toBe(0)
  })

  it('uang pas menghasilkan kembalian nol', () => {
    const c = calculateCash(48_500, 48_500)
    expect(c.sufficient).toBe(true)
    expect(c.changeAmount).toBe(0)
  })

  it('uang kurang dilaporkan sebagai kekurangan, bukan kembalian negatif', () => {
    const c = calculateCash(48_500, 20_000)
    expect(c.sufficient).toBe(false)
    expect(c.changeAmount).toBe(0)
    expect(c.shortfall).toBe(28_500)
  })

  it('transaksi nol rupiah sah (seluruh item digratiskan)', () => {
    const c = calculateCash(0, 0)
    expect(c.sufficient).toBe(true)
    expect(c.changeAmount).toBe(0)
  })

  it('menolak nominal negatif atau pecahan', () => {
    expect(() => calculateCash(-1, 0)).toThrow()
    expect(() => calculateCash(100.5, 200)).toThrow()
  })

  it('assertCashSufficient melempar kalau uang kurang', () => {
    expect(() => assertCashSufficient(48_500, 20_000)).toThrow(PaymentError)
    expect(assertCashSufficient(48_500, 50_000).changeAmount).toBe(1_500)
  })
})

describe('quickCashOptions', () => {
  it('selalu diawali uang pas', () => {
    const opts = quickCashOptions(48_500)
    expect(opts[0]?.exact).toBe(true)
    expect(opts[0]?.value).toBe(48_500)
    expect(opts[0]?.label).toBe('Uang pas')
  })

  it('menawarkan pecahan yang lebih besar dari total', () => {
    const opts = quickCashOptions(48_500)
    const values = opts.map((o) => o.value)
    expect(values).toContain(50_000)
    expect(values).toContain(100_000)
    // Pecahan lebih kecil dari total tidak pernah muncul — tidak ada gunanya.
    expect(values.filter((v) => v !== 48_500).every((v) => v > 48_500)).toBe(true)
  })

  it('label memakai singkatan yang lazim dibaca kasir', () => {
    const opts = quickCashOptions(4_000)
    expect(opts.map((o) => o.label)).toContain('5rb')
    expect(opts.map((o) => o.label)).toContain('10rb')
  })

  it('total besar mendapat pembulatan ke atas, bukan daftar kosong', () => {
    // Rp 235.000: tidak ada pecahan tunggal yang cukup, jadi tawarkan
    // kelipatan 50rb dan 100rb berikutnya.
    const opts = quickCashOptions(235_000)
    const values = opts.map((o) => o.value)
    expect(values).toContain(235_000)
    expect(values).toContain(250_000)
    expect(values).toContain(300_000)
    expect(values.every((v) => v >= 235_000)).toBe(true)
  })

  it('tidak pernah melebihi limit dan tidak pernah duplikat', () => {
    for (const amount of [0, 1_000, 4_000, 48_500, 99_999, 235_000, 1_000_000]) {
      const opts = quickCashOptions(amount)
      expect(opts.length).toBeLessThanOrEqual(4)
      expect(new Set(opts.map((o) => o.value)).size).toBe(opts.length)
      expect(opts.every((o) => o.value >= amount)).toBe(true)
    }
  })

  it('nominal pas pada pecahan tidak menawarkan pecahan itu lagi', () => {
    const opts = quickCashOptions(50_000)
    expect(opts.filter((o) => o.value === 50_000)).toHaveLength(1)
  })
})
