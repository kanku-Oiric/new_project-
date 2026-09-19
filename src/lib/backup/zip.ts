/**
 * Penulis ZIP minimal — metode "store" (tanpa kompresi).
 *
 * Kenapa ditulis sendiri dan bukan memakai library:
 *
 *  - Proyek ini menahan diri soal dependensi (bcryptjs dipilih justru untuk
 *    menghindari build native di Windows). Menambah satu paket untuk merangkai
 *    30 KB CSV bukan pertukaran yang sepadan.
 *  - Format ZIP untuk berkas yang disimpan apa adanya sangat kecil: tiga struktur
 *    header dan CRC32. Seluruhnya di bawah 150 baris, dan bisa diuji sampai
 *    Windows sendiri yang membuka hasilnya (tests/export.test.ts).
 *
 * Tanpa kompresi dengan sengaja. Isinya CSV yang tidak besar, dan implementasi
 * deflate sendiri adalah tempat yang jauh lebih mudah salah — ZIP yang rusak
 * baru terasa saat pemilik membutuhkan datanya.
 */

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** Bit 11 = nama berkas UTF-8. Diisi walau nama kita ASCII, supaya eksplisit. */
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0

const CRC_TABLE = buildCrcTable()

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
}

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    const index = (crc ^ byte) & 0xff
    crc = ((CRC_TABLE[index] ?? 0) ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Tanggal & waktu format DOS, yang dipakai ZIP sejak 1989.
 *
 * Detik disimpan dalam 5 bit, jadi resolusinya 2 detik — bukan kekurangan
 * implementasi ini, memang begitu formatnya. Tahun dihitung dari 1980.
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (Math.floor(date.getSeconds() / 2) & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getHours() & 0x1f) << 11)
  const d =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9)
  return { time, date: d }
}

export interface ZipEntry {
  /** Nama di dalam arsip. Pemisah folder selalu '/', bahkan di Windows. */
  name: string
  data: Buffer
}

/**
 * Rangkai satu arsip ZIP.
 *
 * Susunannya: [header lokal + isi] × n, lalu direktori pusat, lalu EOCD. Offset
 * di direktori pusat menunjuk ke posisi header lokal masing-masing berkas —
 * inilah satu-satunya bagian yang mudah salah, dan yang membuat arsip "terlihat
 * benar" tapi gagal dibuka.
 */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0)
    local.writeUInt16LE(20, 4) // versi minimum untuk membuka
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(METHOD_STORE, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18) // terkompresi
    local.writeUInt32LE(size, 22) // asli — sama, karena tidak dikompresi
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // panjang extra field

    locals.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
    central.writeUInt16LE(20, 4) // versi pembuat
    central.writeUInt16LE(20, 6) // versi minimum
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(METHOD_STORE, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // komentar
    central.writeUInt16LE(0, 34) // nomor disk
    central.writeUInt16LE(0, 36) // atribut internal
    central.writeUInt32LE(0, 38) // atribut eksternal
    central.writeUInt32LE(offset, 42)

    centrals.push(central, name)

    offset += local.length + name.length + size
  }

  const centralBuffer = Buffer.concat(centrals)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // nomor disk ini
  eocd.writeUInt16LE(0, 6) // disk tempat direktori pusat dimulai
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // panjang komentar arsip

  return Buffer.concat([...locals, centralBuffer, eocd])
}
