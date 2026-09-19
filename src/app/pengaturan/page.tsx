import { redirect } from 'next/navigation'
import { Nav } from '@/components/ui/nav'
import { getSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { listNotificationProviders } from '@/lib/notify/registry'
import { listProviders } from '@/lib/payment/registry'
import { getAllSettingsRaw, maskSecret } from '@/lib/settings'
import { NotifikasiSettings, type ChannelStatus } from './notifikasi-settings'
import { QrisSettings } from './qris-settings'

export const dynamic = 'force-dynamic'

export default async function PengaturanPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.mustChangePin) redirect('/ganti-pin')
  if (session.role !== 'OWNER') redirect('/kasir')

  const raw = await getAllSettingsRaw()

  // Label tiap provider berasal dari providernya sendiri. Halaman ini hanya
  // menampilkannya, jadi tidak ada tempat di UI yang bisa menulis klaim yang
  // lebih berani daripada keadaan sebenarnya (docs/qris.md §3.2).
  const providers = await Promise.all(
    listProviders().map(async (p) => {
      const readiness = await p.describe()
      return {
        name: p.name,
        method: p.method,
        settlesOnCreate: p.settlesOnCreate,
        ...readiness,
      }
    }),
  )

  // "Terakhir berhasil" diambil dari pengiriman yang BENAR-BENAR terkirim,
  // bukan dari kredensial yang terisi.
  const notifChannels: ChannelStatus[] = await Promise.all(
    listNotificationProviders().map(async (p) => {
      const readiness = await p.describe()
      const lastSent = await prisma.reportDelivery.findFirst({
        where: { channel: p.channel, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      })
      return {
        channel: p.channel,
        configured: readiness.configured,
        label: readiness.label,
        hint: readiness.hint,
        lastSentAt: lastSent?.sentAt?.toISOString() ?? null,
      }
    }),
  )

  return (
    <>
      <Nav role={session.role} userName={session.name} />
      <main className="mx-auto w-full max-w-2xl p-4">
        <h1 className="mb-1 text-xl font-semibold text-kasir-text">Pengaturan</h1>
        <p className="mb-4 text-sm text-kasir-muted">
          Setiap perubahan di halaman ini meminta PIN pemilik dan tercatat di audit log.
        </p>

        <section className="mb-4 rounded-xl border border-kasir-border bg-kasir-surface p-4">
          <h2 className="text-base font-semibold text-kasir-text">Metode pembayaran</h2>
          <ul className="mt-2 divide-y divide-kasir-border">
            {providers.map((p) => (
              <li key={p.name} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-kasir-text">{p.label}</p>
                  {p.hint && <p className="mt-0.5 text-xs text-kasir-muted">{p.hint}</p>}
                </div>
                <span
                  className={`shrink-0 rounded-lg px-2 py-1 text-xs ${
                    p.configured
                      ? 'bg-green-50 text-kasir-accent-strong'
                      : 'bg-kasir-bg text-kasir-muted'
                  }`}
                >
                  {p.configured ? 'aktif' : 'tidak aktif'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-kasir-muted">
            Tidak ada payment gateway yang tersambung. Tidak ada webhook, tidak ada pengecekan
            status otomatis, dan tidak ada transaksi yang bisa lunas tanpa kasir menekan tombol.
          </p>
        </section>

        <QrisSettings
          enabled={raw.qrisEnabled === 'true'}
          imageName={raw.qrisImagePath}
        />

        <NotifikasiSettings
          channels={notifChannels}
          discordMasked={maskSecret(raw.discordWebhookUrl)}
          telegramTokenMasked={maskSecret(raw.telegramBotToken)}
          telegramChatId={raw.telegramChatId}
        />
      </main>
    </>
  )
}
