import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { config } from '../config'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from './pin-constants'

/**
 * PIN kasir.
 *
 * PIN 4–6 digit itu entropi rendah — 10.000 sampai 1.000.000 kemungkinan.
 * Yang membuatnya cukup untuk konteks ini bukan panjangnya, melainkan tiga hal:
 *  1. user dipilih lebih dulu, jadi tidak ada enumerasi akun dari PIN,
 *  2. lockout berjenjang setelah beberapa kali gagal,
 *  3. jaringan LAN tertutup di dalam toko.
 * Semuanya ditulis apa adanya di docs/architecture.md §7.1.
 */

export { PIN_MIN_LENGTH, PIN_MAX_LENGTH } from './pin-constants'

export const PinSchema = z
  .string()
  .regex(/^\d+$/, 'PIN hanya boleh berisi angka')
  .min(PIN_MIN_LENGTH, `PIN minimal ${PIN_MIN_LENGTH} angka`)
  .max(PIN_MAX_LENGTH, `PIN maksimal ${PIN_MAX_LENGTH} angka`)

/** PIN yang terlalu mudah ditebak, ditolak saat pembuatan/penggantian. */
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '1212', '2121',
  '000000', '111111', '123456', '654321', '121212',
])

export function isWeakPin(pin: string): boolean {
  return WEAK_PINS.has(pin)
}

export async function hashPin(pin: string): Promise<string> {
  const parsed = PinSchema.parse(pin)
  return bcrypt.hash(parsed, config.auth.bcryptRounds)
}

/**
 * Verifikasi PIN. Selalu menjalankan bcrypt bahkan untuk input yang bentuknya
 * salah, supaya waktu responsnya tidak membocorkan apakah user ada atau apakah
 * formatnya benar.
 */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(pin, hash)
  } catch {
    return false
  }
}

/** Hash pembanding untuk user yang tidak ada — menjaga waktu respons seragam. */
const DUMMY_HASH = bcrypt.hashSync('000000', config.auth.bcryptRounds)

export async function burnVerifyTime(): Promise<void> {
  await bcrypt.compare('000000', DUMMY_HASH)
}

// ─────────────────────────────── Session token ───────────────────────────────

/**
 * Token session: 32 byte acak, dikirim ke client lewat cookie httpOnly.
 * Yang disimpan di DB hanya sha256-nya, jadi isi tabel `sessions` tidak bisa
 * dipakai untuk menyamar sebagai siapa pun.
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}
