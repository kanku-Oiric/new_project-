import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IdempotencyKeySchema, canonicalJson, newIdempotencyKey } from './idempotency'
import { fingerprint } from './idempotency-server'

describe('canonicalJson', () => {
  it('tidak peduli urutan properti', () => {
    // Kalau urutan properti ikut menentukan, sidik jari bisa berubah hanya karena
    // client membangun objeknya dengan urutan berbeda — dan pengulangan yang SAH
    // akan ditolak sebagai "keranjang berbeda".
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  it('mengurutkan properti bersarang juga', () => {
    const kiri = { lines: [{ qty: 2, productId: 'p1' }], method: 'CASH' }
    const kanan = { method: 'CASH', lines: [{ productId: 'p1', qty: 2 }] }
    expect(canonicalJson(kiri)).toBe(canonicalJson(kanan))
  })

  it('menyamakan properti undefined dengan properti yang tidak ada', () => {
    // Zod menghapus field optional yang tidak dikirim, jadi dua bentuk ini
    // sampai ke service sebagai request yang sama.
    expect(canonicalJson({ a: 1, note: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('TETAP peduli urutan elemen array', () => {
    // Array adalah urutan yang bermakna. Yang membuat sidik jari checkout tidak
    // peduli urutan baris adalah pengurutan eksplisit di checkoutFingerprint,
    // bukan perilaku fungsi ini.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('membedakan angka dari string berisi angka', () => {
    expect(canonicalJson({ qty: 2 })).not.toBe(canonicalJson({ qty: '2' }))
  })
})

describe('fingerprint', () => {
  it('isi sama → sidik jari sama, isi beda → beda', () => {
    const a = { lines: [{ productId: 'p1', qty: 2 }], transactionDiscount: 0 }
    const b = { transactionDiscount: 0, lines: [{ qty: 2, productId: 'p1' }] }
    const c = { lines: [{ productId: 'p1', qty: 3 }], transactionDiscount: 0 }

    expect(fingerprint(a)).toBe(fingerprint(b))
    expect(fingerprint(a)).not.toBe(fingerprint(c))
  })

  it('panjangnya tetap 64 hex, apa pun besar isinya', () => {
    const besar = { lines: Array.from({ length: 200 }, (_, i) => ({ productId: `p${i}`, qty: 1 })) }
    expect(fingerprint(besar)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('newIdempotencyKey', () => {
  it('menghasilkan UUID yang diterima skema server', () => {
    const key = newIdempotencyKey()
    expect(key).not.toBeNull()
    expect(() => IdempotencyKeySchema.parse(key)).not.toThrow()
  })

  it('tidak mengulang kunci', () => {
    const banyak = new Set(Array.from({ length: 500 }, () => newIdempotencyKey()))
    expect(banyak.size).toBe(500)
  })

  it('BEKERJA walau crypto.randomUUID tidak ada', () => {
    // Ini inti dari keputusan di src/lib/idempotency.ts. `crypto.randomUUID`
    // hanya ada di secure context; LAN toko berjalan di HTTP tanpa TLS, jadi di
    // HP kasir fungsi itu memang undefined. Kalau kunci dibuat dengan randomUUID,
    // checkout akan gagal di HP kasir dan LOLOS di localhost — bug yang tidak
    // terlihat saat diuji di laptop server.
    const asli = globalThis.crypto
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: asli.getRandomValues.bind(asli) },
        configurable: true,
      })
      const key = newIdempotencyKey()
      expect(key).not.toBeNull()
      expect(() => IdempotencyKeySchema.parse(key)).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: asli, configurable: true })
    }
  })

  it('mengembalikan null kalau tidak ada sumber acak sama sekali', () => {
    // Lebih baik tanpa kunci (kembali ke peringatan lama) daripada kunci yang
    // bisa bertabrakan — tabrakan berarti kasir menerima struk penjualan lain.
    const asli = globalThis.crypto
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
      expect(newIdempotencyKey()).toBeNull()
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: asli, configurable: true })
    }
  })
})

describe('penjaga struktural', () => {
  it('tidak ada satu pun file src yang memanggil crypto.randomUUID()', () => {
    // Penjaga, bukan sekadar catatan. Alasannya sama seperti test di atas: fungsi
    // itu undefined di HP kasir, dan pemanggilnya akan gagal hanya di sana.
    const pelanggaran: string[] = []

    const telusuri = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          telusuri(full)
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          // Berkas test dikecualikan: ia tidak pernah ikut ke bundle yang dibuka
          // HP kasir, dan test di atas justru HARUS menyebut nama fungsi itu.
          const isi = fs.readFileSync(full, 'utf8')
          // Baris komentar dikecualikan: file ini sendiri MENJELASKAN kenapa
          // randomUUID dihindari, dan penjelasan itu bukan pemanggilan.
          const baris = isi
            .split('\n')
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .filter((l) => l.includes('randomUUID('))
          if (baris.length > 0) pelanggaran.push(`${full}: ${baris[0]?.trim() ?? ''}`)
        }
      }
    }

    telusuri(path.join(process.cwd(), 'src'))
    expect(pelanggaran).toEqual([])
  })
})
