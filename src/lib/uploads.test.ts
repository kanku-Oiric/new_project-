import { describe, expect, it } from 'vitest'
import { contentTypeForUpload, isSafeUploadName, sniffImageType, uploadFileName } from './uploads'

/**
 * Berkas unggahan dilayani kembali ke browser, jadi dua hal harus benar sebelum
 * menyentuh filesystem: tipenya ditentukan dari ISI berkas, dan namanya tidak
 * bisa keluar dari folder uploads.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

describe('sniffImageType', () => {
  it('mengenali PNG, JPG, dan WEBP dari magic bytes', () => {
    expect(sniffImageType(PNG)?.ext).toBe('png')
    expect(sniffImageType(JPG)?.contentType).toBe('image/jpeg')
    expect(sniffImageType(WEBP)?.ext).toBe('webp')
  })

  it('menolak SVG, HTML, dan berkas kosong', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const html = new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>')

    // SVG ditolak dengan sengaja: ia dokumen yang bisa memuat script, dan berkas
    // ini dilayani kembali ke browser kasir.
    expect(sniffImageType(svg)).toBeNull()
    expect(sniffImageType(html)).toBeNull()
    expect(sniffImageType(new Uint8Array([]))).toBeNull()
  })

  it('menolak berkas yang hanya MENGAKU gambar lewat nama', () => {
    // Nama dan content-type dari browser bisa dikarang siapa pun di WiFi toko.
    const fake = new TextEncoder().encode('ini bukan gambar sama sekali')
    expect(sniffImageType(fake)).toBeNull()
  })

  it('RIFF tanpa penanda WEBP ditolak', () => {
    const riffWave = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ])
    expect(sniffImageType(riffWave)).toBeNull()
  })
})

describe('isSafeUploadName', () => {
  it('menerima nama berstempel waktu yang kita hasilkan sendiri', () => {
    expect(isSafeUploadName('qris-20260919-101500.png')).toBe(true)
    expect(isSafeUploadName(uploadFileName('qris', 'png', new Date(2026, 8, 19, 10, 15, 0)))).toBe(
      true,
    )
  })

  it('menolak segala bentuk keluar dari folder uploads', () => {
    for (const name of [
      '../pos.db',
      '..\\pos.db',
      'a/../../pos.db',
      'sub/qr.png',
      'sub\\qr.png',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '.env',
      '',
      '..',
    ]) {
      expect(isSafeUploadName(name), name).toBe(false)
    }
  })
})

describe('uploadFileName', () => {
  it('berstempel waktu, sehingga gambar lama tidak tertimpa diam-diam', () => {
    const name = uploadFileName('qris', 'webp', new Date(2026, 8, 19, 9, 5, 3))
    expect(name).toBe('qris-20260919-090503.webp')
    expect(contentTypeForUpload(name)).toBe('image/webp')
  })
})

describe('contentTypeForUpload', () => {
  it('hanya tipe gambar yang dikenal yang boleh dilayani', () => {
    expect(contentTypeForUpload('qr.png')).toBe('image/png')
    expect(contentTypeForUpload('qr.JPEG')).toBe('image/jpeg')
    expect(contentTypeForUpload('pos.db')).toBeNull()
    expect(contentTypeForUpload('nota.pdf')).toBeNull()
    expect(contentTypeForUpload('skrip.svg')).toBeNull()
  })
})
