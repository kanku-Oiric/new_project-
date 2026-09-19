import fs from 'node:fs/promises'
import path from 'node:path'
import { clientIp, deviceLabel, ok, route } from '@/lib/api'
import { recordAudit } from '@/lib/audit'
import { verifyOwnerPin } from '@/lib/auth/login'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/auth/pin-constants'
import { requireRole } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { ValidationError } from '@/lib/errors'
import { getSetting, setSetting } from '@/lib/settings'
import {
  UPLOAD_MAX_BYTES,
  ensureUploadsDir,
  sniffImageType,
  uploadFileName,
} from '@/lib/uploads'

export const dynamic = 'force-dynamic'

/**
 * Unggah gambar QRIS statis toko.
 *
 * Multipart, bukan JSON, karena isinya berkas biner. Yang tersimpan di setting
 * hanyalah NAMA berkasnya — bukan path — sehingga tidak ada nilai di database
 * yang bisa menunjuk keluar dari folder uploads.
 *
 * Gambar lama tidak dihapus. Kalau pemilik keliru mengunggah QR milik toko lain,
 * yang benar masih ada di folder dan bisa dipulihkan.
 */
export const POST = route('settings.qrisImage', async (req) => {
  const session = await requireRole('OWNER')

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    throw new ValidationError('Body request bukan form-data yang valid')
  }

  const pin = form.get('ownerPin')
  const file = form.get('file')

  if (typeof pin !== 'string' || pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    throw new ValidationError('PIN pemilik wajib diisi')
  }
  if (!(file instanceof File)) {
    throw new ValidationError('Pilih berkas gambar QR terlebih dahulu')
  }
  if (file.size === 0) {
    throw new ValidationError('Berkas yang dipilih kosong')
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    throw new ValidationError(
      `Gambar terlalu besar (${Math.round(file.size / 1024)} KB). Maksimal ${UPLOAD_MAX_BYTES / 1024} KB.`,
    )
  }

  const authorizedByUserId = await verifyOwnerPin(pin)

  const bytes = new Uint8Array(await file.arrayBuffer())

  // Tipe ditentukan dari ISI berkas. Nama dan content-type dari browser bisa
  // dikarang siapa pun yang ada di WiFi toko, dan berkas ini nantinya dilayani
  // kembali ke browser.
  const type = sniffImageType(bytes)
  if (!type) {
    throw new ValidationError('Berkas harus berupa gambar PNG, JPG, atau WEBP')
  }

  const dir = await ensureUploadsDir()
  const name = uploadFileName('qris', type.ext, new Date())
  await fs.writeFile(path.join(dir, name), bytes)

  const before = await getSetting('qrisImagePath')
  await setSetting('qrisImagePath', name, session.id)

  await recordAudit(
    prisma,
    {
      userId: session.id,
      role: session.role,
      ip: clientIp(req),
      deviceLabel: deviceLabel(req),
    },
    {
      action: 'SETTING_CHANGE',
      summary: `Gambar QRIS statis diunggah (${name})`,
      entityType: 'Setting',
      entityId: 'qrisImagePath',
      before: { value: before },
      after: { value: name, bytes: bytes.length, authorizedByUserId },
    },
  )

  return ok({ qrisImagePath: name, bytes: bytes.length }, 201)
})
