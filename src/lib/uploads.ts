import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config'
import { ValidationError } from './errors'
import { UPLOAD_MAX_BYTES } from './uploads-limits'

/**
 * Gambar unggahan (v1: hanya gambar QRIS statis).
 *
 * Disimpan di `data/uploads/`, bukan di `public/`, karena `public/` disajikan
 * tanpa autentikasi dan isinya ikut ke dalam hasil build. Berkasnya dilayani
 * lewat route yang memeriksa session.
 *
 * Fungsi-fungsi murni di file ini (`sniffImageType`, `isSafeUploadName`)
 * sengaja tidak menyentuh filesystem supaya bisa diuji sebagai unit.
 */

export { UPLOAD_MAX_BYTES }

export interface ImageType {
  ext: 'png' | 'jpg' | 'webp'
  contentType: 'image/png' | 'image/jpeg' | 'image/webp'
}

const TYPES: Record<ImageType['ext'], ImageType> = {
  png: { ext: 'png', contentType: 'image/png' },
  jpg: { ext: 'jpg', contentType: 'image/jpeg' },
  webp: { ext: 'webp', contentType: 'image/webp' },
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, i) => bytes[i] === byte)
}

/**
 * Tentukan tipe gambar dari ISI berkas, bukan dari nama atau header yang
 * dikirim browser. Keduanya bisa dikarang siapa saja yang berada di WiFi toko.
 *
 * SVG sengaja TIDAK didukung: ia dokumen yang bisa memuat script, dan kita
 * melayani berkas ini kembali ke browser.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return TYPES.png
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return TYPES.jpg
  // WEBP: "RIFF" .... "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return TYPES.webp
  }
  return null
}

/**
 * Nama berkas yang boleh dilayani: satu segmen, tanpa pemisah folder, tanpa
 * titik-titik naik. Yang disimpan di setting memang hanya nama berkasnya, jadi
 * apa pun yang lebih rumit dari ini adalah usaha keluar dari folder uploads.
 */
export function isSafeUploadName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name) && !name.includes('..')
}

export function contentTypeForUpload(name: string): string | null {
  const ext = path.extname(name).replace('.', '').toLowerCase()
  if (ext === 'png') return TYPES.png.contentType
  if (ext === 'jpg' || ext === 'jpeg') return TYPES.jpg.contentType
  if (ext === 'webp') return TYPES.webp.contentType
  return null
}

/** Path absolut berkas unggahan. Melempar kalau namanya tidak aman. */
export function uploadPathFor(name: string): string {
  if (!isSafeUploadName(name)) {
    throw new ValidationError('Nama berkas tidak sah')
  }
  const full = path.resolve(config.paths.uploads, name)

  // Pemeriksaan kedua setelah resolve: kalaupun regex di atas suatu hari
  // dilonggarkan, berkas di luar folder uploads tetap tidak bisa disentuh.
  const root = path.resolve(config.paths.uploads)
  if (full !== path.join(root, path.basename(full)) || !full.startsWith(root + path.sep)) {
    throw new ValidationError('Nama berkas tidak sah')
  }
  return full
}

export async function ensureUploadsDir(): Promise<string> {
  await fs.mkdir(config.paths.uploads, { recursive: true })
  return config.paths.uploads
}

/** Nama berkas berstempel waktu, supaya gambar lama tidak tertimpa diam-diam. */
export function uploadFileName(prefix: string, ext: ImageType['ext'], now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${prefix}-${stamp}.${ext}`
}
