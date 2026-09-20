'use client'

import { SERVICE_CATALOG } from '@/lib/service/catalog'
import { formatRupiah } from '@/lib/money'
import type { ServiceKind } from '@/lib/enums'
import type { KasirProvider } from './types'

/**
 * Panel jasa pembayaran, di samping grid produk dan dipisahkan garis.
 *
 * Bukan tab tersembunyi, dan bukan halaman lain. Alasannya bukan estetika:
 * pelanggan yang membeli token listrik sering sekalian membeli barang, dan
 * kalau jasa ada di layar lain maka kasir harus membuat dua transaksi terpisah
 * untuk satu orang yang membayar sekali. Yang tersembunyi di balik tab juga
 * berarti satu ketukan tambahan pada setiap transaksi yang paling sering
 * dilakukan di jam ramai.
 *
 * Di layar sempit rail ini menjadi strip mendatar DI ATAS daftar produk —
 * tetap satu ketukan, tetap terlihat tanpa dicari.
 */
export function ServiceRail({
  providers,
  onPick,
  disabled,
}: {
  providers: KasirProvider[]
  onPick: (kind: ServiceKind) => void
  disabled: boolean
}) {
  const belumAdaProvider = providers.length === 0

  return (
    <aside className="flex min-h-0 shrink-0 flex-col gap-2 border-kasir-border lg:w-48 lg:border-l lg:pl-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-kasir-muted">
        Jasa pembayaran
      </h2>

      {belumAdaProvider ? (
        // Tombol yang bisa ditekan tapi selalu gagal lebih buruk daripada
        // penjelasan singkat. Kasir tidak bisa membuat provider sendiri, jadi
        // yang disebut adalah siapa yang bisa.
        <p className="rounded-lg border border-dashed border-kasir-border p-3 text-xs text-kasir-muted">
          Belum ada provider. Pemilik menambahkannya di halaman Saldo sebelum jasa bisa dijual.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
            {SERVICE_CATALOG.map((spec) => (
              <button
                key={spec.kind}
                type="button"
                disabled={disabled}
                onClick={() => onPick(spec.kind)}
                className={`flex min-h-[56px] flex-col justify-center rounded-xl border px-3 py-2 text-left disabled:opacity-40 ${
                  spec.direction === 'PROVIDER_IN'
                    ? // Arah uangnya berlawanan — warnanya pun harus berbeda,
                      // supaya kasir tidak menekannya karena kebiasaan.
                      'border-kasir-warning/60 bg-kasir-warning/10'
                    : 'border-kasir-border bg-kasir-surface'
                }`}
              >
                <span className="text-sm font-medium text-kasir-text">{spec.label}</span>
                <span className="text-[11px] leading-tight text-kasir-muted">{spec.hint}</span>
              </button>
            ))}
          </div>

          <div className="mt-1 border-t border-kasir-border pt-2">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-kasir-muted">Saldo</p>
            <ul className="space-y-0.5">
              {providers.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 text-xs">
                  <span className="truncate text-kasir-muted">{p.nama}</span>
                  <span
                    className={
                      p.saldo <= 0 ? 'font-medium text-kasir-danger' : 'text-kasir-text'
                    }
                  >
                    {formatRupiah(p.saldo, { bare: true })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </aside>
  )
}
