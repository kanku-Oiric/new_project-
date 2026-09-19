/**
 * Hook startup Next.js.
 *
 * LOKASI FILE INI PENTING: project memakai folder `src/`, dan Next.js mencari
 * `instrumentation.ts` di dalam `src/` — bukan di root. Menaruhnya di root
 * membuat `register()` tidak pernah dipanggil, tanpa error apa pun.
 *
 * BENTUK GUARD-NYA JUGA PENTING. Next.js mengompilasi file ini untuk runtime
 * Node DAN runtime edge. Webpack mengganti `process.env.NEXT_RUNTIME` dengan
 * literal lalu membuang cabang yang mati — tapi itu hanya bekerja andal untuk
 * blok `if` yang tidak terambil. Bentuk sebelumnya:
 *
 *     if (process.env.NEXT_RUNTIME !== 'nodejs') return
 *     const { runStartupTasksOnce } = await import('./lib/startup')
 *
 * tidak dieliminasi: webpack tetap menelusuri import itu untuk build edge, lalu
 * gagal meresolusi `node:fs`, `node:crypto`, dan `crypto` milik bcryptjs. Yang
 * rusak bukan cuma startup — SELURUH module graph dev server ikut gagal, dan
 * setiap route mengembalikan 500, termasuk yang sama sekali tidak memakai
 * startup.
 *
 * Meletakkan import di dalam `if` positif adalah pola yang didokumentasikan
 * Next.js, dan membuat seluruh subtree Node-only benar-benar terbuang dari
 * build edge.
 *
 * docs/architecture.md §10.1
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runStartupTasksOnce } = await import('./lib/startup')
    await runStartupTasksOnce()
  }
}
