import { describe, expect, it } from 'vitest'
import type { Db } from './audit'
import { SETTING_DEFS, SETTING_KEYS, getSetting, isSecretKey, maskSecret } from './settings'

/**
 * `getSetting` berjanji mengembalikan default kalau barisnya tidak ada atau
 * nilainya rusak — "sistem tidak boleh berhenti jualan karena satu setting
 * cacat". Janji itu hanya bisa ditepati kalau setiap default memang sah menurut
 * schema-nya sendiri.
 *
 * Test ini ada karena janji itu pernah dilanggar: `installDate` punya schema
 * regex tanggal dengan default string kosong, sehingga setting yang belum
 * pernah diisi justru MELEMPAR saat dibaca — dan ketahuan pertama kali dari
 * catch-up laporan yang gagal, jauh dari tempat kesalahannya.
 */
describe('default setting', () => {
  it('setiap default lolos schema-nya sendiri', () => {
    for (const key of SETTING_KEYS) {
      const def = SETTING_DEFS[key]
      const parsed = def.schema.safeParse(def.default)
      expect(parsed.success, `default untuk "${key}" tidak lolos schema-nya sendiri`).toBe(true)
    }
  })

  it('nilai kosong pada setting opsional tetap terbaca, bukan melempar', () => {
    for (const key of ['installDate', 'storeAddress', 'discordWebhookUrl'] as const) {
      expect(SETTING_DEFS[key].schema.safeParse('').success).toBe(true)
    }
  })
})

describe('penandaan rahasia', () => {
  it('webhook dan token ditandai rahasia, chat id dan nama toko tidak', () => {
    expect(isSecretKey('discordWebhookUrl')).toBe(true)
    expect(isSecretKey('telegramBotToken')).toBe(true)
    expect(isSecretKey('telegramChatId')).toBe(false)
    expect(isSecretKey('storeName')).toBe(false)
  })

  it('masker menyisakan empat karakter terakhir supaya pemilik bisa mengenalinya', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret('abc')).toBe('••••')
    expect(maskSecret('1234567890abcd')).toBe('••••abcd')
  })
})

describe('nilai tersimpan yang rusak tidak boleh menjatuhkan halaman', () => {
  /**
   * Bug yang ditemukan dari log server saat pemeriksaan manual:
   *
   *   ⨯ SyntaxError: Unexpected end of JSON input
   *     at JSON.parse (<anonymous>) { page: '/pengaturan' }
   *   GET /pengaturan 500
   *
   * `getSetting` dirancang punya jaring: kalau nilai tersimpan tidak lolos
   * skemanya, ia kembali ke default. Jaring itu ternyata TIDAK PERNAH TERPASANG
   * untuk `expenseCategories`, karena skemanya memanggil `JSON.parse` di dalam
   * `.transform()` — dan `safeParse` Zod tidak menangkap exception yang dilempar
   * dari dalam transform. Yang terjadi bukan "kembali ke default", melainkan
   * 500 di halaman.
   *
   * Satu baris setting yang kosong sesaat sudah cukup menjatuhkan halaman
   * pengeluaran di tengah jam kerja.
   */
  function dbDenganNilai(value: string): Db {
    return {
      setting: { findUnique: async () => ({ key: 'expenseCategories', value }) },
    } as unknown as Db
  }

  const RUSAK = ['', 'bukan json', '{"a":1}', '[1,2,3]', 'null', '[']

  it('safeParse pada skema TIDAK melempar untuk nilai rusak apa pun', () => {
    for (const nilai of RUSAK) {
      expect(
        () => SETTING_DEFS.expenseCategories.schema.safeParse(nilai),
        `safeParse melempar untuk ${JSON.stringify(nilai)}`,
      ).not.toThrow()
    }
  })

  it('getSetting kembali ke default, bukan melempar', async () => {
    for (const nilai of RUSAK) {
      const hasil = await getSetting('expenseCategories', dbDenganNilai(nilai))
      expect(Array.isArray(hasil), `hasil untuk ${JSON.stringify(nilai)}`).toBe(true)
      expect(hasil.length).toBeGreaterThan(0)
    }
  })

  it('nilai yang SAH tetap dipakai apa adanya', async () => {
    const hasil = await getSetting(
      'expenseCategories',
      dbDenganNilai(JSON.stringify(['Bensin', 'Plastik'])),
    )
    expect(hasil).toEqual(['Bensin', 'Plastik'])
  })

  it('TIDAK ADA skema setting yang melempar pada safeParse', () => {
    // Penjaga menyeluruh: apa pun yang tersimpan di tabel settings — hasil edit
    // manual, migrasi setengah jalan, atau berkas yang rusak — tidak boleh
    // membuat halaman mana pun 500.
    const nilaiAneh = ['', ' ', 'null', 'undefined', '[', '{', 'NaN', '-1', 'true']
    const pelanggar: string[] = []

    for (const [key, def] of Object.entries(SETTING_DEFS)) {
      for (const nilai of nilaiAneh) {
        try {
          def.schema.safeParse(nilai)
        } catch {
          pelanggar.push(`${key} ← ${JSON.stringify(nilai)}`)
        }
      }
    }

    expect(pelanggar).toEqual([])
  })
})
