import { describe, expect, it } from 'vitest'
import { SETTING_DEFS, SETTING_KEYS, isSecretKey, maskSecret } from './settings'

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
    for (const key of ['installDate', 'qrisImagePath', 'discordWebhookUrl'] as const) {
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
