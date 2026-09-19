/**
 * Antrean pengiriman: satu consumer, dijalankan berurutan.
 *
 * Referensi: docs/architecture.md §11
 *
 * Gunanya bukan performa, melainkan sopan santun dan ketertiban: catch-up bisa
 * punya 30 laporan tertunda, dan menembakkan semuanya sekaligus ke Discord
 * adalah cara tercepat untuk kena rate limit. Antrean juga mencegah catch-up
 * saat startup berlomba dengan tombol "Kirim laporan sekarang" yang ditekan
 * pemilik pada detik yang sama.
 *
 * Durabilitasnya TIDAK di sini. Antrean ini hidup di memori dan hilang begitu
 * proses mati; yang menjamin laporan tidak hilang adalah baris di tabel
 * `report_deliveries` yang dipungut catch-up berikutnya.
 */

const globalForQueue = globalThis as unknown as { notifyQueueTail?: Promise<unknown> }

/**
 * Jalankan `task` setelah semua task sebelumnya selesai.
 *
 * Mengembalikan hasil task-nya, sehingga pemanggil yang memang menunggu jawaban
 * (tombol kirim manual) tetap bisa menampilkan hasilnya, sementara pemanggil
 * yang tidak menunggu (catch-up saat startup) cukup mengabaikan promise-nya.
 */
export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalForQueue.notifyQueueTail ?? Promise.resolve()

  // Ekor antrean sengaja tidak pernah rejected: satu task gagal tidak boleh
  // membatalkan task-task setelahnya.
  const run = previous.then(task, task)

  globalForQueue.notifyQueueTail = run.then(
    () => undefined,
    () => undefined,
  )

  return run
}

/** Tunggu antrean kosong. Dipakai test supaya tidak perlu menebak waktu. */
export async function drainQueue(): Promise<void> {
  await (globalForQueue.notifyQueueTail ?? Promise.resolve())
}
