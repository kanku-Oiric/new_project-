import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Penjaga atas TEST-nya sendiri.
 *
 * Ada satu kesalahan yang tidak akan pernah membuat test merah, tapi merusak
 * data toko: test yang menjalankan server tanpa mengalihkan folder backup.
 *
 * Yang terjadi kalau terlewat — dan ini benar-benar terjadi, ditemukan setelah
 * Fase 7 selesai dan seluruh test hijau:
 *
 *   1. test menjalankan `next dev` dengan DATABASE_URL ke database sementara,
 *   2. startup dan tutup shift menjalankan backup otomatis,
 *   3. backup itu menulis snapshot DATABASE UJI ke folder `backups/` TOKO,
 *   4. prune menyisakan 30 berkas terbaru, jadi backup toko yang asli terhapus
 *      untuk memberi tempat bagi snapshot uji,
 *   5. `backups/` berisi 30 berkas yang semuanya berisi "Kasir E2E" dengan nol
 *      transaksi, dan tidak satu pun bisa dibedakan dari backup sungguhan,
 *   6. pemilik mengikuti README A6 ("pilih yang paling baru") lalu memulihkan
 *      database kosong ke atas data tokonya.
 *
 * Keenam langkah itu berjalan tanpa satu pun test berwarna merah. Karena itu
 * penjaganya di sini, bukan di kepala siapa pun.
 */

const ROOT = path.join(__dirname, '..')
const BERKAS_INI = 'test-hygiene.test.ts'

function testFiles(): { file: string; text: string }[] {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(__dirname, f), 'utf8') }))
}

describe('kebersihan test', () => {
  it('setiap test yang menjalankan server WAJIB mengalihkan BACKUP_DIR', () => {
    // Penandanya argumen `'dev',` yang diberikan ke `next` lewat spawn. Semua
    // test HTTP memakai bentuk itu, dan tidak ada tempat lain yang memakainya.
    const pelanggaran = testFiles()
      .filter(({ file }) => file !== BERKAS_INI)
      .filter(({ text }) => text.includes("'dev',"))
      .filter(({ text }) => !text.includes('BACKUP_DIR'))
      .map(({ file }) => file)

    expect(pelanggaran).toEqual([])
  })

  it('setiap test yang memanggil runBackup atau closeShift mengalihkan BACKUP_DIR', () => {
    // `closeShift` memanggil `runBackup` di dalamnya, jadi test yang
    // memanggilnya langsung (bukan lewat HTTP) juga bisa menulis ke folder
    // backup toko.
    const pelanggaran = testFiles()
      .filter(({ file }) => file !== BERKAS_INI)
      .filter(({ text }) => /\b(runBackup|closeShift)\s*\(/.test(text))
      .filter(({ text }) => !text.includes('BACKUP_DIR'))
      .map(({ file }) => file)

    expect(pelanggaran).toEqual([])
  })

  it('tidak ada test yang menyebut folder backups/ atau data/pos.db milik toko', () => {
    // Sengaja sempit: hanya `backups` dan `data/pos.db`.
    //
    // Versi pertama penjaga ini juga menandai `'data'`, dan langsung menangkap
    // enam `server.stderr?.on('data', ...)` — nama event, bukan folder. Penjaga
    // yang berteriak pada hal tidak berbahaya akan dimatikan seseorang, dan saat
    // itu ia berhenti menjaga apa pun. Jadi yang dijaga hanya dua nama yang
    // benar-benar pernah merusak data.
    const pelanggaran: string[] = []

    for (const { file, text } of testFiles()) {
      if (file === BERKAS_INI) continue

      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        const menyebutFolderToko = line.includes('backups') || line.includes('data/pos.db')
        if (menyebutFolderToko && !line.includes('tmpDir')) {
          pelanggaran.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }

    expect(pelanggaran).toEqual([])
  })

  it('tidak ada test yang memakai tanggal UTC sebagai hari usaha', () => {
    // Ditemukan saat bug hunting, pukul 06:00 WIB: sebuah test meminta laporan
    // harian untuk tanggal UTC, lalu gagal dengan "expected 0 to be 16500" —
    // karena seluruh transaksinya tercatat pada hari usaha WIB yang sudah
    // berganti tujuh jam lebih dulu.
    //
    // Test itu LULUS sepanjang jam kerja dan hanya merah antara 00:00 dan
    // 07:00 WIB. Kegagalan yang cuma muncul di jam tertentu lebih buruk
    // daripada tidak ada test: ia mengajari orang mengabaikan warna merah,
    // dan orang berikutnya akan menjalankannya ulang lalu menganggapnya
    // "kadang memang begitu".
    //
    // Penjaganya di sini karena tidak ada pemeriksaan lain yang bisa
    // menangkapnya: typecheck, lint, dan build semuanya hijau.
    const pelanggaran: string[] = []

    for (const { file, text } of testFiles()) {
      if (file === BERKAS_INI) continue

      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        if (/toISOString\(\)\s*\.slice\(0,\s*10\)/.test(line)) {
          pelanggaran.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }

    expect(pelanggaran).toEqual([])
  })

  it('folder backups/ toko tidak memuat snapshot database uji', () => {
    // Pemeriksaan atas keadaan NYATA, bukan atas bentuk kode. Kalau seseorang
    // menjalankan test dengan cara yang melewati ketiga penjaga di atas,
    // sisa-sisanya tetap tertangkap di sini pada run berikutnya.
    const dir = path.join(ROOT, 'backups')
    if (!fs.existsSync(dir)) {
      expect(fs.existsSync(dir)).toBe(false)
      return
    }

    // Nama kasir yang HANYA ada di fixture test. Kalau muncul di dalam berkas
    // backup, berkas itu bukan backup toko.
    const PENANDA_UJI = [
      'Kasir E2E',
      'Kasir HTTP',
      'Kasir Laporan',
      'Kasir QRIS',
      'Kasir Idem',
      'Kasir F7',
      'Kasir Backup',
      'Toko Idem',
      'Toko Fase 7',
    ]

    const tercemar: string[] = []
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.db'))) {
      // Dibaca sebagai byte, bukan lewat SQLite: teks tersimpan apa adanya di
      // dalam halaman b-tree, dan pencarian biasa sudah cukup mengenalinya tanpa
      // perlu membuka database.
      const isi = fs.readFileSync(path.join(dir, file), 'latin1')
      const penanda = PENANDA_UJI.find((p) => isi.includes(p))
      if (penanda) tercemar.push(`${file} (memuat "${penanda}")`)
    }

    expect(tercemar).toEqual([])
  })
})
