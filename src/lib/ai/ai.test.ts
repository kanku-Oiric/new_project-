import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregateSales, compareAggregates, type ReportInput } from '../report'
import { AI_PAYLOAD_KEYS, buildAiPayload } from './payload'
import { InsightSchema, formatInsight, parseInsight } from './schema'
import { AiError, callGemini } from './client'

/**
 * Data uji yang memuat hal-hal yang TIDAK boleh keluar dari toko, supaya test
 * bisa membuktikan ketiadaannya — bukan mengasumsikannya.
 */
const INPUT: ReportInput = {
  transactions: [
    {
      id: 'trx-rahasia-1',
      businessDate: '2026-09-14',
      status: 'COMPLETED',
      grossSubtotal: 36_000,
      itemDiscountTotal: 6_000,
      transactionDiscount: 0,
      netTotal: 30_000,
      cogsTotal: 24_000,
      passthroughTotal: 0,
      serviceFeeTotal: 0,
      services: [],
      paidMethod: 'CASH',
      items: [
        {
          productId: 'prod-rahasia-1',
          productName: 'Kopi Sachet',
          qty: 3,
          lineFinal: 30_000,
          unitCost: 8_000,
        },
      ],
    },
  ],
  refunds: [],
  expenses: [
    { businessDate: '2026-09-15', kategori: 'Operasional', amount: 5_000, paidFrom: 'CASH_DRAWER' },
  ],
  shifts: [
    {
      cashierName: 'Kasir Sari',
      status: 'CLOSED',
      businessDate: '2026-09-14',
      openedAt: new Date('2026-09-14T01:00:00Z'),
      closedAt: new Date('2026-09-14T13:00:00Z'),
      expectedCash: 100_000,
      countedCash: 98_000,
      difference: -2_000,
    },
  ],
  stock: [
    { productName: 'Gula', stok: 2, stokMinimum: 5, satuan: 'pcs' },
    { productName: 'Minyak', stok: -1, stokMinimum: 3, satuan: 'pcs' },
  ],
}

const AGGREGATE = aggregateSales(INPUT)

describe('buildAiPayload', () => {
  const payload = buildAiPayload(AGGREGATE, { kind: 'WEEKLY', periodKey: '2026-W38' })

  it('hanya memuat kunci yang terdaftar', () => {
    // Kalau seseorang menambah field di SalesAggregate lalu menyalinnya ke sini,
    // test ini merah. Menambah data yang keluar dari toko harus jadi keputusan
    // yang terlihat di diff, bukan efek samping.
    expect(Object.keys(payload).sort()).toEqual([...AI_PAYLOAD_KEYS].sort())
  })

  it('TIDAK memuat nomor meter, nomor HP, atau rekening pelanggan', () => {
    // Satu-satunya data pelanggan yang disimpan sistem ini adalah `customerRef`
    // pada baris jasa. Ia tidak pernah sampai ke sini bukan karena disaring,
    // melainkan karena agregasi hanya menjumlahkan angka per JENIS jasa —
    // baris per-transaksi tidak punya jalur ke payload.
    const jasa = buildAiPayload(
      aggregateSales({
        ...INPUT,
        transactions: [
          {
            ...INPUT.transactions[0]!,
            serviceFeeTotal: 2_500,
            passthroughTotal: 100_000,
            services: [
              {
                kind: 'TOKEN_LISTRIK',
                label: 'Token Listrik',
                direction: 'PROVIDER_OUT',
                providerName: 'Shopee',
                passthroughAmount: 100_000,
                serviceFeeAmount: 2_500,
                providerCostAmount: 0,
              },
            ],
          },
        ],
      }),
      { kind: 'WEEKLY', periodKey: '2026-W38' },
    )

    const teks = JSON.stringify(jasa)
    expect(jasa.jasaPembayaran.pendapatanAdmin).toBe(2_500)
    expect(jasa.jasaPembayaran.titipanKeluar).toBe(100_000)
    // Nama provider pun tidak ikut: model tidak membutuhkannya.
    expect(teks).not.toContain('Shopee')
    expect(teks).not.toContain('customerRef')
  })

  it('TIDAK memuat nama kasir', () => {
    // Bukan assertion kosong: `SalesAggregate.shifts` MEMANG memuat `cashierName`
    // (lihat ReportShiftRow), dan payload ini menerima agregat itu utuh. Yang
    // diuji adalah bahwa buildAiPayload tidak meneruskannya.
    //
    // Laporan ini menilai penjualan, bukan orang. Nama karyawan tidak dibutuhkan
    // analisis mana pun, jadi ia tidak dikirim ke layanan pihak ketiga.
    expect(AGGREGATE.shifts[0]?.cashierName).toBe('Kasir Sari')
    expect(JSON.stringify(payload)).not.toContain('Kasir Sari')
  })

  it('TIDAK memuat id maupun timestamp', () => {
    // `shifts` di agregat memuat openedAt/closedAt, dan id transaksi ada di
    // ReportInput. Keduanya tidak menambah apa pun bagi analisis agregat.
    const teks = JSON.stringify(payload)
    expect(teks).not.toContain('rahasia')
    expect(teks).not.toContain('2026-09-14T')
    expect(teks).not.toContain('openedAt')
  })

  it('selisih kas ikut sebagai ANGKA TOTAL, tanpa pemiliknya', () => {
    expect(payload.kas.selisihTotal).toBe(-2_000)
    expect(payload.kas.jumlahShift).toBe(1)
    expect(JSON.stringify(payload.kas)).not.toContain('Sari')
  })

  it('membawa angka penjualan yang sama dengan agregat', () => {
    expect(payload.penjualan.kotor).toBe(AGGREGATE.grossSales)
    expect(payload.penjualan.bersih).toBe(AGGREGATE.netSales)
    expect(payload.penjualan.labaKotor).toBe(AGGREGATE.grossProfit)
    expect(payload.penjualan.jumlahTransaksi).toBe(1)
  })

  it('rataRataTransaksi null kalau tidak ada transaksi, bukan 0', () => {
    const kosong = aggregateSales({
      transactions: [],
      refunds: [],
      expenses: [],
      shifts: [],
      stock: [],
    })
    const p = buildAiPayload(kosong, { kind: 'MONTHLY', periodKey: '2026-09' })
    expect(p.penjualan.rataRataTransaksi).toBeNull()
  })

  it('memisahkan stok minus dari stok di bawah minimum', () => {
    expect(payload.stok.dibawahMinimum).toBe(1)
    expect(payload.stok.minus).toBe(1)
  })

  it('perbandingan hanya membawa angka periode sebelumnya', () => {
    const sebelumnya = aggregateSales({
      transactions: [],
      refunds: [],
      expenses: [],
      shifts: [],
      stock: [],
    })
    const p = buildAiPayload(
      AGGREGATE,
      { kind: 'WEEKLY', periodKey: '2026-W38' },
      compareAggregates(AGGREGATE, sebelumnya),
    )
    expect(p.perbandingan).toEqual({
      bersihSebelumnya: 0,
      labaKotorSebelumnya: 0,
      jumlahTransaksiSebelumnya: 0,
      refundSebelumnya: 0,
    })
  })

  it('daftar produk dibatasi lima baris', () => {
    const pertama = INPUT.transactions[0]
    const item = pertama?.items[0]
    expect(pertama && item).toBeTruthy()
    if (!pertama || !item) return

    const banyak = aggregateSales({
      ...INPUT,
      transactions: Array.from({ length: 12 }, (_, i) => ({
        ...pertama,
        id: `trx-${i}`,
        items: [{ ...item, productId: `p-${i}`, productName: `Produk ${i}` }],
      })),
    })
    const p = buildAiPayload(banyak, { kind: 'WEEKLY', periodKey: '2026-W38' })
    expect(p.produkTerlaris.length).toBeLessThanOrEqual(5)
    expect(p.produkLabaTertinggi.length).toBeLessThanOrEqual(5)
  })
})

describe('penjaga struktural payload', () => {
  it('payload.ts tidak mengimpor settings, config, prisma, atau auth', () => {
    // Inilah yang membuat jaminan "tidak ada credential yang bisa masuk" bukan
    // sekadar janji: modul yang menyusun payload tidak punya jalan menuju
    // sumber-sumber itu sama sekali.
    const isi = fs.readFileSync(path.join(__dirname, 'payload.ts'), 'utf8')
    const impor = [...isi.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1])

    expect(impor).toEqual(['../report'])
    for (const terlarang of ['settings', 'config', 'db/prisma', 'auth/']) {
      expect(isi).not.toContain(`from '../${terlarang}`)
    }
  })

  it('hanya service.ts yang memanggil callGemini', () => {
    // Batas 1×/hari ditegakkan di service.ts. Pintu kedua ke klien akan membuat
    // penegakan itu tidak berarti.
    const pemanggil: string[] = []
    const telusuri = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) telusuri(full)
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const isi = fs.readFileSync(full, 'utf8')
          const baris = isi
            .split('\n')
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .filter((l) => l.includes('callGemini('))
          if (baris.length > 0) {
            // Pemisah path dinormalkan: di Windows `path.relative` menghasilkan
            // backslash, dan test yang hanya lulus di satu sistem operasi bukan
            // penjaga, ia kebetulan.
            pemanggil.push(
              path.relative(path.join(__dirname, '../..'), full).split(path.sep).join('/'),
            )
          }
        }
      }
    }
    telusuri(path.join(__dirname, '../..'))

    expect(pemanggil.sort()).toEqual(['lib/ai/client.ts', 'lib/ai/service.ts'].sort())
  })

  it('tidak ada jalur AI di dalam checkout atau pembayaran', () => {
    // AI tidak pernah dipanggil per transaksi. Bukan aturan di kepala orang:
    // berkas-berkas itu tidak boleh menyebut modul ai sama sekali.
    for (const rel of ['lib/checkout/index.ts', 'lib/transaction/service.ts', 'lib/shift/service.ts']) {
      const isi = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8')
      expect(isi).not.toContain("from '../ai")
      expect(isi).not.toContain('requestInsight')
    }
  })
})

describe('InsightSchema & parseInsight', () => {
  const sah = {
    ringkasan: 'Penjualan minggu ini naik dibanding minggu lalu, terutama dari produk kopi.',
    temuan: ['Kopi Sachet menyumbang penjualan terbesar', 'Selisih kas minus dua ribu rupiah'],
    saran: ['Tambah stok Kopi Sachet', 'Periksa penyebab selisih kas'],
  }

  it('menerima bentuk yang benar', () => {
    const hasil = parseInsight(JSON.stringify(sah))
    expect(hasil.ok).toBe(true)
  })

  it('melepas pembungkus blok kode markdown', () => {
    // Model kadang membungkus JSON walau diminta JSON murni. Membuang jawaban
    // yang isinya benar hanya karena tiga petik akan membakar kuota satu hari.
    const hasil = parseInsight(`\`\`\`json\n${JSON.stringify(sah)}\n\`\`\``)
    expect(hasil.ok).toBe(true)
  })

  it('menolak yang bukan JSON', () => {
    const hasil = parseInsight('Tentu! Berikut analisisnya: penjualan naik.')
    expect(hasil.ok).toBe(false)
    if (!hasil.ok) expect(hasil.error).toContain('bukan JSON')
  })

  it('menolak JSON yang kekurangan field', () => {
    const hasil = parseInsight(JSON.stringify({ ringkasan: sah.ringkasan }))
    expect(hasil.ok).toBe(false)
    if (!hasil.ok) expect(hasil.error).toContain('tidak sesuai skema')
  })

  it('menolak array kosong', () => {
    const hasil = parseInsight(JSON.stringify({ ...sah, temuan: [] }))
    expect(hasil.ok).toBe(false)
  })

  it('menolak ringkasan yang terlalu panjang', () => {
    // Tanpa batas, satu jawaban yang mengamuk membuat pesan Discord ditolak
    // karena melewati batas field — kegagalan di bagian paling tidak penting
    // menjatuhkan laporan yang seharusnya terkirim.
    const hasil = parseInsight(JSON.stringify({ ...sah, ringkasan: 'a'.repeat(601) }))
    expect(hasil.ok).toBe(false)
  })

  it('menolak tipe yang salah', () => {
    const hasil = parseInsight(JSON.stringify({ ...sah, temuan: 'bukan array' }))
    expect(hasil.ok).toBe(false)
  })

  it('formatInsight menghasilkan teks biasa, bukan markup', () => {
    const teks = formatInsight(InsightSchema.parse(sah))
    expect(teks).toContain(sah.ringkasan)
    expect(teks).toContain('Temuan:')
    expect(teks).toContain('• Tambah stok Kopi Sachet')
    // Tidak ada tag HTML maupun sintaks yang bisa dieksekusi di mana pun.
    expect(teks).not.toMatch(/<[a-z]/i)
  })
})

describe('callGemini', () => {
  const payload = buildAiPayload(AGGREGATE, { kind: 'WEEKLY', periodKey: '2026-W38' })

  function jawaban(text: string, status = 200): Response {
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
      { status, headers: { 'Content-Type': 'application/json' } },
    )
  }

  it('mengirim kunci di HEADER, tidak di URL', async () => {
    // Kunci API di query string akan ikut tercatat di log akses, pesan error,
    // dan riwayat — tiga tempat yang tidak pernah dimaksudkan menyimpan rahasia.
    let url = ''
    let headers: Record<string, string> = {}

    await callGemini(payload, {
      apiKey: 'RAHASIA-123',
      model: 'gemini-2.0-flash',
      fetchImpl: async (input, init) => {
        url = String(input)
        headers = (init?.headers ?? {}) as Record<string, string>
        return jawaban('{"ringkasan":"cukup panjang untuk lolos","temuan":["a"],"saran":["b"]}')
      },
    })

    expect(url).not.toContain('RAHASIA-123')
    expect(url).not.toContain('key=')
    expect(headers['x-goog-api-key']).toBe('RAHASIA-123')
  })

  it('menolak jalan tanpa kunci API', async () => {
    let dipanggil = false
    await expect(
      callGemini(payload, {
        apiKey: '',
        model: 'gemini-2.0-flash',
        fetchImpl: async () => {
          dipanggil = true
          return jawaban('{}')
        },
      }),
    ).rejects.toBeInstanceOf(AiError)
    expect(dipanggil).toBe(false)
  })

  it('membuang kunci API dari pesan error', async () => {
    const error = await callGemini(payload, {
      apiKey: 'RAHASIA-123',
      model: 'gemini-2.0-flash',
      fetchImpl: async () => new Response('gagal untuk kunci RAHASIA-123', { status: 400 }),
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AiError)
    expect((error as AiError).message).not.toContain('RAHASIA-123')
    expect((error as AiError).message).toContain('<api-key>')
  })

  it('melempar AiError pada status non-2xx, dengan statusnya', async () => {
    const error = await callGemini(payload, {
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () => new Response('kuota habis', { status: 429 }),
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AiError)
    expect((error as AiError).status).toBe(429)
  })

  it('melempar kalau response tidak memuat teks', async () => {
    await expect(
      callGemini(payload, {
        apiKey: 'k',
        model: 'm',
        fetchImpl: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('melempar kalau response bukan JSON sama sekali', async () => {
    await expect(
      callGemini(payload, {
        apiKey: 'k',
        model: 'm',
        fetchImpl: async () => new Response('<html>error</html>', { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('berhenti sendiri kalau Gemini tidak menjawab', async () => {
    const error = await callGemini(payload, {
      apiKey: 'k',
      model: 'm',
      timeoutMs: 30,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AiError)
    expect((error as AiError).message).toContain('tidak menjawab')
  })

  it('prompt memuat payload dan larangan mengarang angka', async () => {
    let body = ''
    await callGemini(payload, {
      apiKey: 'k',
      model: 'm',
      fetchImpl: async (_input, init) => {
        body = String(init?.body ?? '')
        return jawaban('{"ringkasan":"cukup panjang untuk lolos","temuan":["a"],"saran":["b"]}')
      },
    })

    expect(body).toContain('jangan mengarang angka')
    expect(body).toContain('2026-W38')
    expect(body).toContain('application/json')
    // Nama kasir tidak boleh ikut sampai ke badan request.
    expect(body).not.toContain('Kasir Budi')
  })
})
