import { describe, expect, it } from 'vitest'
import { classifyResponse, outcomeMessage, readErrorEnvelope } from './api-client'

describe('classifyResponse', () => {
  it('2xx dengan JSON adalah sukses', () => {
    const out = classifyResponse<{ trxNumber: string }>(201, { trxNumber: 'TRX-1' }, true)
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') expect(out.data.trxNumber).toBe('TRX-1')
  })

  it('500 dengan halaman HTML dilaporkan sebagai ERROR SERVER, bukan error jaringan', () => {
    // Inilah bug yang melatarbelakangi modul ini: server menjawab 500 dengan
    // HTML, `res.json()` melempar, dan kasir membaca "Koneksi terputus".
    const out = classifyResponse(500, undefined, false)
    expect(out.kind).toBe('server-error')
    if (out.kind === 'server-error') {
      expect(out.status).toBe(500)
      expect(out.message).toContain('500')
    }
  })

  it('500 dengan envelope JSON memakai pesan dari server', () => {
    const out = classifyResponse(500, { error: { code: 'INTERNAL', message: 'Gagal di server' } }, true)
    expect(out.kind).toBe('server-error')
    if (out.kind === 'server-error') expect(out.message).toBe('Gagal di server')
  })

  it('4xx adalah client-error dan membawa kode dari server', () => {
    const out = classifyResponse(
      400,
      { error: { code: 'VALIDATION', message: 'Keranjang kosong' } },
      true,
    )
    expect(out.kind).toBe('client-error')
    if (out.kind === 'client-error') {
      expect(out.code).toBe('VALIDATION')
      expect(out.message).toBe('Keranjang kosong')
      expect(out.status).toBe(400)
    }
  })

  it('401 dan 409 tetap client-error, bukan server-error', () => {
    expect(classifyResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Login dulu' } }, true).kind)
      .toBe('client-error')
    expect(classifyResponse(409, { error: { code: 'CONFLICT', message: 'Sudah diproses' } }, true).kind)
      .toBe('client-error')
  })

  it('4xx tanpa envelope tetap terbaca, tidak melempar', () => {
    const out = classifyResponse(404, undefined, false)
    expect(out.kind).toBe('client-error')
    if (out.kind === 'client-error') {
      expect(out.code).toBe('UNKNOWN')
      expect(out.message).toContain('404')
    }
  })

  it('2xx yang isinya bukan JSON dianggap error server, bukan sukses kosong', () => {
    // Kalau ini dianggap sukses, kasir melihat transaksi "berhasil" tanpa
    // nomor transaksi dan tanpa struk.
    const out = classifyResponse(200, undefined, false)
    expect(out.kind).toBe('server-error')
  })

  it('502 dan 503 masuk server-error', () => {
    expect(classifyResponse(502, undefined, false).kind).toBe('server-error')
    expect(classifyResponse(503, undefined, false).kind).toBe('server-error')
  })
})

describe('readErrorEnvelope', () => {
  it('membaca envelope yang benar', () => {
    expect(readErrorEnvelope({ error: { code: 'X', message: 'pesan' } })).toEqual({
      code: 'X',
      message: 'pesan',
    })
  })

  it('mengembalikan null untuk bentuk yang tidak dikenal', () => {
    expect(readErrorEnvelope(undefined)).toBeNull()
    expect(readErrorEnvelope(null)).toBeNull()
    expect(readErrorEnvelope('teks')).toBeNull()
    expect(readErrorEnvelope({})).toBeNull()
    expect(readErrorEnvelope({ error: 'teks' })).toBeNull()
    expect(readErrorEnvelope({ error: { code: 'X' } })).toBeNull()
  })

  it('kode yang hilang diisi UNKNOWN, pesan tetap dipakai', () => {
    expect(readErrorEnvelope({ error: { message: 'ada pesan' } })).toEqual({
      code: 'UNKNOWN',
      message: 'ada pesan',
    })
  })
})

describe('outcomeMessage', () => {
  it('client-error tidak memperingatkan soal mengulang — aman diperbaiki lalu diulang', () => {
    const msg = outcomeMessage(
      { kind: 'client-error', status: 400, code: 'VALIDATION', message: 'Uang kurang' },
      true,
    )
    expect(msg).toBe('Uang kurang')
    expect(msg).not.toContain('JANGAN')
  })

  it('server-error pada request yang mengubah data memperingatkan jangan diulang', () => {
    const msg = outcomeMessage({ kind: 'server-error', status: 500, message: 'Gagal.' }, true)
    expect(msg).toContain('JANGAN ulangi')
    expect(msg).toContain('riwayat transaksi')
  })

  it('network-error pada request yang mengubah data juga memperingatkan', () => {
    // Dari browser, "tidak pernah sampai" dan "sampai tapi jawabannya hilang"
    // tidak bisa dibedakan. Menyuruh mengulang bisa berarti pelanggan terbayar
    // dua kali.
    const msg = outcomeMessage({ kind: 'network-error', message: 'Tidak ada jawaban.' }, true)
    expect(msg).toContain('JANGAN ulangi')
  })

  it('request baca-saja tidak memperingatkan soal pembayaran ganda', () => {
    const msg = outcomeMessage({ kind: 'network-error', message: 'Tidak bisa menghubungi server.' }, false)
    expect(msg).not.toContain('JANGAN')
  })
})
