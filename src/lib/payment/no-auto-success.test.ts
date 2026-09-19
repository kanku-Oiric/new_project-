import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Larangan keras docs/qris.md §3.2, ditegakkan sebagai test alih-alih hanya
 * disepakati di dokumen.
 *
 * Test ini memeriksa KODE SUMBER, bukan perilaku, dan itu memang tujuannya:
 * yang dijaga adalah bentuk sistemnya. Sebuah `setTimeout` yang melunaskan
 * pembayaran, atau jalur kedua yang menulis `paidAt`, mungkin lolos semua test
 * perilaku sementara tetap salah secara struktural — dan justru cacat seperti itu
 * yang berakhir sebagai "transaksi lunas padahal uangnya tidak pernah masuk".
 */

const ROOT = process.cwd()

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (entry.name.includes('.test.')) continue
    out.push(full)
  }
  return out
}

function sourceFiles(...relative: string[]): { file: string; text: string }[] {
  return relative
    .flatMap((rel) => {
      const full = path.join(ROOT, rel)
      if (!fs.existsSync(full)) return []
      return fs.statSync(full).isDirectory() ? walk(full) : [full]
    })
    .map((file) => ({
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      text: fs.readFileSync(file, 'utf8'),
    }))
}

/** Buang komentar, supaya kalimat yang MENJELASKAN larangan tidak ikut kena. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('tidak ada jalur otomatis menuju PAID', () => {
  const PAYMENT_PATHS = [
    'src/lib/payment',
    'src/lib/checkout',
    'src/app/api/payments',
    'src/components/kasir/qris-pending.tsx',
    'src/app/kasir/kasir-client.tsx',
  ]

  it('tidak ada timer di seluruh jalur pembayaran', () => {
    const offenders = sourceFiles(...PAYMENT_PATHS)
      .filter(({ text }) => /\b(setTimeout|setInterval|setImmediate)\s*\(/.test(stripComments(text)))
      .map(({ file }) => file)

    // Satu-satunya jalan menuju PAID adalah request yang dipicu manusia. Timer
    // apa pun di jalur ini adalah kandidat "sukses sendiri setelah beberapa
    // detik", dan itu dilarang di dev maupun di test fixture.
    expect(offenders).toEqual([])
  })

  it('hanya SATU berkas di seluruh src yang menulis paidAt', () => {
    // MEMBACA paidAt tidak dilarang, MENULISNYA yang dilarang.
    //
    // Penjaga ini dulu menandai setiap kemunculan `paidAt:` dan karena itu ikut
    // menangkap `select: { paidAt: true }` di dashboard — kode yang hanya
    // membaca, untuk mengetahui apakah sebuah QRIS pernah benar-benar dibayar.
    // Penjaga yang menangkap hal yang tidak berbahaya akan dilonggarkan
    // seseorang di kemudian hari, dan saat itu ia berhenti menjaga apa pun.
    //
    // Bentuk yang diizinkan tanpa dianggap menulis: `paidAt: true` dan
    // `paidAt: false` (Prisma `select`). Semua nilai lain dihitung sebagai
    // penulisan — termasuk `paidAt: now` dan `paidAt: null`.
    const writers = sourceFiles('src')
      .filter(({ text }) => {
        const bersih = stripComments(text)
        const matches = [...bersih.matchAll(/paidAt\s*:\s*([A-Za-z0-9_.]+)/g)]
        return matches.some((m) => m[1] !== 'true' && m[1] !== 'false')
      })
      .map(({ file }) => file)

    // `settleTransactionInTx` adalah satu-satunya penulis. Tunai, QRIS statis,
    // dan nanti webhook/polling provider dinamis semuanya bermuara ke sana, jadi
    // apa pun yang benar sekarang tetap benar setelah provider asli masuk
    // (docs/qris.md §6).
    expect(writers).toEqual(['src/lib/checkout/index.ts'])
  })

  it('penjaga penulis paidAt benar-benar menangkap penulisan baru', () => {
    // Penjaga yang tidak pernah diuji tidak bisa dipercaya. Ini memastikan
    // pelonggaran di test sebelumnya tidak membuatnya berhenti menangkap
    // penulisan sungguhan.
    const contoh = [
      'await tx.payment.update({ data: { paidAt: now } })',
      'data: { paidAt: new Date() }',
      'await tx.payment.updateMany({ data: { paidAt: null } })',
    ]
    const bacaan = ['select: { paidAt: true }', 'select: { paidAt: false }']

    const menulis = (text: string): boolean =>
      [...text.matchAll(/paidAt\s*:\s*([A-Za-z0-9_.]+)/g)].some(
        (m) => m[1] !== 'true' && m[1] !== 'false',
      )

    for (const c of contoh) expect(menulis(c)).toBe(true)
    for (const b of bacaan) expect(menulis(b)).toBe(false)
  })

  it('status PAID hanya ditulis lewat guarded update', () => {
    const settle = fs.readFileSync(path.join(ROOT, 'src/lib/checkout/index.ts'), 'utf8')

    // Gerbangnya harus `updateMany` dengan syarat status PENDING lalu pemeriksaan
    // count. `update` biasa akan berhasil dua kali dan mengurangi stok dua kali.
    expect(settle).toMatch(/payment\.updateMany\(\{[\s\S]*?status:\s*'PENDING'/)
    expect(settle).toMatch(/updated\.count\s*!==\s*1/)
  })
})
