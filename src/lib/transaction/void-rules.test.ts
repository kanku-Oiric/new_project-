import { describe, expect, it } from 'vitest'
import {
  checkVoidEligibility,
  voidNeedsManualRefund,
  type VoidEligibilityInput,
} from './void-rules'

function input(overrides: Partial<VoidEligibilityInput> = {}): VoidEligibilityInput {
  return {
    status: 'COMPLETED',
    businessDate: '2026-09-19',
    shiftStatus: 'OPEN',
    hasRefund: false,
    today: '2026-09-19',
    ...overrides,
  }
}

describe('checkVoidEligibility', () => {
  it('mengizinkan void hari ini saat shift masih terbuka', () => {
    expect(checkVoidEligibility(input())).toEqual({ canVoid: true, reason: null })
  })

  it('SHIFT DITUTUP → menolak dan menyebut jalan keluarnya', () => {
    const out = checkVoidEligibility(input({ shiftStatus: 'CLOSED' }))
    expect(out.canVoid).toBe(false)
    expect(out.reason).toBe('Shift sudah ditutup — gunakan refund')
  })

  it('BUKAN HARI INI → menolak dan menyebut jalan keluarnya', () => {
    const out = checkVoidEligibility(input({ businessDate: '2026-09-18' }))
    expect(out.canVoid).toBe(false)
    expect(out.reason).toBe('Transaksi bukan hari ini — gunakan refund')
  })

  it('SUDAH DI-REFUND → menolak dan menyebut jalan keluarnya', () => {
    const out = checkVoidEligibility(input({ hasRefund: true }))
    expect(out.canVoid).toBe(false)
    expect(out.reason).toBe('Transaksi sudah pernah di-refund — gunakan refund untuk sisanya')
  })

  it('SUDAH DI-VOID → menolak', () => {
    expect(checkVoidEligibility(input({ status: 'VOIDED' })).reason).toBe(
      'Transaksi sudah dibatalkan',
    )
  })

  it('BELUM SELESAI → mengarahkan ke Batalkan, bukan refund', () => {
    // Transaksi PENDING belum menyentuh stok dan belum dibayar; "refund" akan
    // menyesatkan karena tidak ada uang yang perlu dikembalikan.
    expect(checkVoidEligibility(input({ status: 'PENDING' })).reason).toBe(
      'Transaksi belum selesai — gunakan Batalkan',
    )
  })

  it('setiap penolakan SELALU menyertakan alasan, tidak pernah null', () => {
    const kasus: Partial<VoidEligibilityInput>[] = [
      { status: 'VOIDED' },
      { status: 'CANCELLED' },
      { status: 'PENDING' },
      { hasRefund: true },
      { businessDate: '2026-09-18' },
      { shiftStatus: 'CLOSED' },
    ]
    for (const k of kasus) {
      const out = checkVoidEligibility(input(k))
      expect(out.canVoid).toBe(false)
      expect(out.reason).toBeTruthy()
      expect(out.reason!.length).toBeGreaterThan(10)
    }
  })

  it('status transaksi diperiksa sebelum tanggal dan shift', () => {
    // Transaksi PENDING dari kemarin pada shift tertutup: pesan yang paling
    // berguna adalah soal statusnya, bukan soal tanggalnya.
    const out = checkVoidEligibility(
      input({ status: 'PENDING', businessDate: '2026-09-18', shiftStatus: 'CLOSED' }),
    )
    expect(out.reason).toContain('belum selesai')
  })

  it('tanggal diperiksa sebelum shift', () => {
    const out = checkVoidEligibility(
      input({ businessDate: '2026-09-18', shiftStatus: 'CLOSED' }),
    )
    expect(out.reason).toBe('Transaksi bukan hari ini — gunakan refund')
  })
})

describe('voidNeedsManualRefund', () => {
  it('QRIS yang sudah PAID menyisakan kewajiban pengembalian manual', () => {
    expect(voidNeedsManualRefund('QRIS_STATIC', 'PAID')).toBe(true)
  })

  it('tunai tidak — uangnya masih di laci dan dikeluarkan langsung', () => {
    expect(voidNeedsManualRefund('CASH', 'PAID')).toBe(false)
  })

  it('QRIS yang belum PAID tidak menyisakan kewajiban', () => {
    for (const s of ['PENDING', 'CANCELLED', 'EXPIRED', 'FAILED'] as const) {
      expect(voidNeedsManualRefund('QRIS_STATIC', s)).toBe(false)
    }
  })
})
