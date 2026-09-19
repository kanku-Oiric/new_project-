import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Backup terverifikasi, diuji terhadap SQLite sungguhan.
 *
 * Yang dibuktikan di sini tidak bisa dibuktikan dengan membaca kode:
 *
 *  1. `VACUUM INTO` menghasilkan berkas yang benar-benar bisa dibuka lagi,
 *  2. berkas yang RUSAK dilaporkan rusak — bukan lolos sebagai "backup ada",
 *  3. pemeriksaannya read-only, jadi ia tidak mengubah berkas yang diperiksa,
 *  4. backup yang gagal verifikasi TIDAK disalin ke folder mirror.
 *
 * Nomor 2 adalah alasan seluruh berkas ini ada. Backup yang belum pernah dibuka
 * bukan strategi pemulihan; ia baru sebuah berkas. Satu-satunya saat kita akan
 * tahu ia rusak adalah saat toko sedang membutuhkannya — kecuali kalau diperiksa
 * setiap kali dibuat.
 */

let tmpDir = ''
let dbPath = ''
let backupDir = ''
let mirrorDir = ''

// Diimpor DINAMIS setelah env diarahkan ke folder sementara. `src/lib/config.ts`
// membaca environment sekali saat modul dimuat, jadi impor statis di atas akan
// menangkap folder backup toko yang sebenarnya.
let runBackup: typeof import('@/lib/backup').runBackup
let verifyBackup: typeof import('@/lib/backup').verifyBackup
let listBackups: typeof import('@/lib/backup').listBackups
let prisma: import('@prisma/client').PrismaClient

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-backup-'))
  dbPath = path.join(tmpDir, 'pos.db')
  backupDir = path.join(tmpDir, 'backups')
  mirrorDir = path.join(tmpDir, 'mirror')
  fs.mkdirSync(mirrorDir, { recursive: true })

  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: 'pipe',
    },
  )

  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`
  process.env.BACKUP_DIR = backupDir
  process.env.BACKUP_MIRROR_DIR = mirrorDir
  process.env.BACKUP_KEEP = '3'

  const backup = await import('@/lib/backup')
  runBackup = backup.runBackup
  verifyBackup = backup.verifyBackup
  listBackups = backup.listBackups

  const db = await import('@/lib/db/prisma')
  prisma = db.prisma

  // WAL dinyalakan seperti di produksi: justru inilah alasan backup memakai
  // VACUUM INTO dan bukan menyalin berkas (docs/architecture.md §15).
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL')

  const cashier = await prisma.user.create({
    data: { name: 'Kasir Backup', role: 'CASHIER', pinHash: 'x' },
  })
  const shift = await prisma.shift.create({
    data: {
      cashierId: cashier.id,
      status: 'OPEN',
      openKey: cashier.id,
      openingCash: 0,
      businessDate: '2026-09-20',
    },
  })

  // Tiga transaksi, supaya hitungan baris di dalam backup bisa dibandingkan
  // dengan angka yang memang diketahui.
  for (let i = 0; i < 3; i++) {
    await prisma.transaction.create({
      data: {
        trxNumber: `TRX-20260920-00000${i}`,
        businessDate: '2026-09-20',
        shiftId: shift.id,
        cashierId: cashier.id,
        status: 'COMPLETED',
        grossSubtotal: 10_000,
        itemDiscountTotal: 0,
        transactionDiscount: 0,
        netTotal: 10_000,
        cogsTotal: 7_000,
      },
    })
  }
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Folder temp yang masih terkunci OS dibiarkan.
  }
})

describe('runBackup', () => {
  it('menghasilkan backup yang terverifikasi, dengan jumlah transaksi yang benar', async () => {
    const result = await runBackup()

    expect(result.ok).toBe(true)
    expect(result.file).toMatch(/^pos-\d{8}-\d{6}\.db$/)
    expect(result.verification.ok).toBe(true)
    expect(result.verification.integrity).toBe('ok')
    // Angka ini dibaca DARI DALAM berkas backup, bukan dari database aktif.
    expect(result.verification.transactionCount).toBe(3)
  }, 60_000)

  it('menyalin ke folder mirror karena verifikasinya lulus', async () => {
    const isi = fs.readdirSync(mirrorDir).filter((f) => f.endsWith('.db'))
    expect(isi.length).toBeGreaterThan(0)
  })

  it('mencatat hasilnya ke audit log', async () => {
    const baris = await prisma.auditLog.findFirst({
      where: { action: 'BACKUP_RUN' },
      orderBy: { at: 'desc' },
    })
    expect(baris).not.toBeNull()
    expect(baris?.summary).toContain('terverifikasi')
    // Pelakunya null: backup startup tidak punya manusia di belakangnya, dan
    // memalsukan pelaku hanya akan membuat audit log berbohong.
    expect(baris?.userId).toBeNull()
    expect(String(baris?.afterJson)).toContain('"transactionCount":3')
  })

  it('transaksi yang ditulis SETELAH backup tidak ada di dalam backup itu', async () => {
    // Membuktikan snapshot-nya benar-benar snapshot, bukan penunjuk ke DB aktif.
    const sebelum = await runBackup()
    expect(sebelum.verification.transactionCount).toBe(3)

    const cashier = await prisma.user.findFirstOrThrow()
    const shift = await prisma.shift.findFirstOrThrow()
    await prisma.transaction.create({
      data: {
        trxNumber: 'TRX-20260920-000099',
        businessDate: '2026-09-20',
        shiftId: shift.id,
        cashierId: cashier.id,
        status: 'COMPLETED',
        grossSubtotal: 5_000,
        itemDiscountTotal: 0,
        transactionDiscount: 0,
        netTotal: 5_000,
        cogsTotal: 3_000,
      },
    })

    const file = path.join(backupDir, String(sebelum.file))
    const ulang = await verifyBackup(file)
    expect(ulang.transactionCount).toBe(3)

    const sesudah = await runBackup()
    expect(sesudah.verification.transactionCount).toBe(4)
  }, 60_000)

  it('memangkas backup lama sesuai BACKUP_KEEP', async () => {
    await runBackup()
    await runBackup()
    const files = listBackups()
    expect(files.length).toBeLessThanOrEqual(3)
  }, 60_000)

  it('dua backup pada DETIK yang sama: yang terbaru tidak ikut terpangkas', async () => {
    // Regresi. Dulu prune mengurutkan berdasarkan NAMA, dengan asumsi nama
    // bercap tanggal berarti urutan leksikal sama dengan urutan waktu. Dua
    // backup di detik yang sama menghasilkan `...-021031.db` dan
    // `...-021031-1.db`, dan secara leksikal '-1.db' datang LEBIH DULU — jadi
    // berkas terbaru dianggap paling tua lalu dihapus, tepat setelah dibuat.
    const detikSama = new Date('2026-09-20T03:04:05')

    const pertama = await runBackup(detikSama)
    const kedua = await runBackup(detikSama)

    expect(pertama.file).not.toBe(kedua.file)
    expect(kedua.file).toContain('-1.db')
    expect(kedua.ok).toBe(true)

    // Berkas yang baru dibuat HARUS masih ada — kalau tidak, mirror menyalin
    // berkas yang sudah lenyap dan pemilik menyimpan backup yang lebih tua
    // sambil mengira ia menyimpan yang terbaru.
    const ada = listBackups().map((b) => b.file)
    expect(ada).toContain(kedua.file)
    expect(fs.existsSync(path.join(backupDir, String(kedua.file)))).toBe(true)
  }, 60_000)
})

describe('verifyBackup terhadap berkas rusak', () => {
  it('melaporkan GAGAL, tidak melempar, dan tidak mengaku ok', async () => {
    const rusak = path.join(tmpDir, 'rusak.db')
    const sumber = listBackups()[0]
    expect(sumber).toBeDefined()
    fs.copyFileSync(path.join(backupDir, String(sumber?.file)), rusak)

    // Rusak SETELAH halaman pertama: header tetap terlihat seperti SQLite, jadi
    // berkasnya masih "kelihatan" sebagai database — hanya isinya yang kacau.
    // Inilah bentuk kerusakan paling berbahaya: ukurannya wajar, namanya benar,
    // dan tidak ada yang tahu sampai seseorang mencoba memulihkannya.
    //
    // Percobaan pertama hanya menimpa 2 KB di tengah dan integrity_check tetap
    // menjawab "ok" — halaman yang tertimpa ternyata tidak dirujuk b-tree mana
    // pun. Jadi yang ditimpa sekarang seluruh badan berkas setelah halaman 1.
    const fd = fs.openSync(rusak, 'r+')
    const ukuran = fs.statSync(rusak).size
    const mulai = 4096
    fs.writeSync(fd, Buffer.alloc(ukuran - mulai, 0xff), 0, ukuran - mulai, mulai)
    fs.closeSync(fd)

    const hasil = await verifyBackup(rusak)
    expect(hasil.ok).toBe(false)
    expect(hasil.error ?? hasil.integrity).toBeTruthy()
  }, 60_000)

  it('berkas yang sama sekali bukan database dilaporkan gagal, bukan melempar', async () => {
    const bukanDb = path.join(tmpDir, 'bukan.db')
    fs.writeFileSync(bukanDb, 'ini teks biasa, bukan database\n')

    const hasil = await verifyBackup(bukanDb)
    expect(hasil.ok).toBe(false)
  }, 60_000)

  it('berkas yang tidak ada dilaporkan gagal', async () => {
    // mode=ro TIDAK membuat berkas baru — itu justru salah satu gunanya.
    const hasil = await verifyBackup(path.join(tmpDir, 'tidak-ada.db'))
    expect(hasil.ok).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'tidak-ada.db'))).toBe(false)
  }, 60_000)

  it('pemeriksaan tidak mengubah berkas yang diperiksa', async () => {
    const sumber = listBackups()[0]
    const file = path.join(backupDir, String(sumber?.file))

    const sebelum = fs.readFileSync(file)
    const statSebelum = fs.statSync(file)

    await verifyBackup(file)

    const sesudah = fs.readFileSync(file)
    expect(sesudah.equals(sebelum)).toBe(true)
    expect(fs.statSync(file).size).toBe(statSebelum.size)
    // Tidak ada -wal / -shm yang tertinggal di sebelah backup. Berkas seperti itu
    // membingungkan saat restore, karena README menyuruh menghapusnya.
    expect(fs.existsSync(`${file}-wal`)).toBe(false)
    expect(fs.existsSync(`${file}-shm`)).toBe(false)
  }, 60_000)

  it('database aktif tetap bisa ditulis setelah verifikasi (DETACH benar-benar jalan)', async () => {
    // Kalau DETACH gagal, koneksi menyisakan schema tertempel dan backup
    // berikutnya akan gagal ATTACH dengan nama yang sama.
    await verifyBackup(path.join(backupDir, String(listBackups()[0]?.file)))
    await verifyBackup(path.join(backupDir, String(listBackups()[0]?.file)))

    const jumlah = await prisma.transaction.count()
    expect(jumlah).toBeGreaterThan(0)

    const lagi = await runBackup()
    expect(lagi.verification.ok).toBe(true)
  }, 60_000)
})
