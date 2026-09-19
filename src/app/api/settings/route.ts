import { z } from 'zod'
import { clientIp, deviceLabel, ok, parseBody, route } from '@/lib/api'
import { verifyOwnerPin } from '@/lib/auth/login'
import { PinSchema } from '@/lib/auth/pin'
import { requireRole } from '@/lib/auth/session'
import { updateSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

const PatchSchema = z.object({
  ownerPin: PinSchema,
  /** Key divalidasi di service terhadap SETTING_DEFS, bukan di sini. */
  values: z.record(z.string(), z.string()),
})

/**
 * Ubah pengaturan toko.
 *
 * Dua gerbang, dan keduanya di server: role OWNER dari session, LALU PIN pemilik
 * yang dikirim ulang di body. Session saja tidak cukup — laptop kasir yang
 * ditinggalkan dalam keadaan login tidak boleh berarti akses pemilik
 * (docs/architecture.md §7.2).
 */
export const PATCH = route('settings.patch', async (req) => {
  const session = await requireRole('OWNER')
  const body = await parseBody(req, PatchSchema)

  const authorizedByUserId = await verifyOwnerPin(body.ownerPin)

  const result = await updateSettings(body.values, {
    userId: session.id,
    role: session.role,
    authorizedByUserId,
    ip: clientIp(req),
    deviceLabel: deviceLabel(req),
  })

  return ok(result)
})
