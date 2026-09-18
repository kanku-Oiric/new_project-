/**
 * Hook startup Next.js.
 *
 * LOKASI FILE INI PENTING: project memakai folder `src/`, dan Next.js mencari
 * `instrumentation.ts` di dalam `src/` — bukan di root. Menaruhnya di root
 * membuat `register()` tidak pernah dipanggil, tanpa error apa pun, sehingga
 * backup dan (nanti) catch-up laporan diam-diam tidak jalan.
 *
 * `register()` adalah satu-satunya titik "on server start" resmi di Next.js,
 * dan berjalan baik di `next dev` maupun `next start`. Inilah sebabnya catch-up
 * laporan (Fase 6) bisa menjadi mekanisme utama, bukan cron — laptop toko
 * dimatikan tiap malam, jadi cron pasti melewatkan laporan.
 *
 * docs/architecture.md §10.1
 */
export async function register(): Promise<void> {
  // Runtime edge tidak punya akses filesystem maupun SQLite.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Import dinamis supaya modul Node-only tidak ikut ter-bundle ke runtime lain.
  const { runStartupTasksOnce } = await import('./lib/startup')
  await runStartupTasksOnce()
}
