import { describe, expect, it } from 'vitest'
import { csvCell, csvRow, toCsv } from './csv'
import { buildZip, crc32 } from './zip'

describe('crc32', () => {
  it('cocok dengan nilai rujukan yang sudah dikenal', () => {
    // Nilai-nilai ini adalah CRC32 standar (IEEE 802.3) yang terdokumentasi luas.
    // Kalau tabelnya salah, ZIP-nya tetap terbentuk tapi ditolak saat dibuka —
    // dan itu baru diketahui saat pemilik membutuhkan datanya.
    expect(crc32(Buffer.from('')).toString(16)).toBe('0')
    expect(crc32(Buffer.from('a')).toString(16)).toBe('e8b7be43')
    expect(crc32(Buffer.from('abc')).toString(16)).toBe('352441c2')
    expect(crc32(Buffer.from('hello world')).toString(16)).toBe('d4a1185')
    expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926')
  })

  it('selalu 32 bit tanpa tanda', () => {
    const nilai = crc32(Buffer.from('nilai yang bisa membuat bit tertinggi menyala: ÿÿÿ'))
    expect(nilai).toBeGreaterThanOrEqual(0)
    expect(nilai).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('buildZip', () => {
  const entries = [
    { name: 'satu.txt', data: Buffer.from('isi berkas pertama\n') },
    { name: 'dua.csv', data: Buffer.from('a,b\r\n1,2\r\n') },
  ]

  it('mengawali dengan signature header lokal', () => {
    const zip = buildZip(entries, new Date('2026-09-20T10:00:00'))
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  })

  it('EOCD di akhir memuat jumlah entri yang benar', () => {
    const zip = buildZip(entries, new Date('2026-09-20T10:00:00'))
    const eocd = zip.length - 22
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50)
    expect(zip.readUInt16LE(eocd + 8)).toBe(2)
    expect(zip.readUInt16LE(eocd + 10)).toBe(2)
  })

  it('offset di direktori pusat benar-benar menunjuk ke header lokal', () => {
    // Bagian yang paling mudah salah. Arsip dengan offset keliru tetap terlihat
    // seperti ZIP yang sah sampai ada yang mencoba membukanya.
    const zip = buildZip(entries, new Date('2026-09-20T10:00:00'))
    const eocd = zip.length - 22
    const centralOffset = zip.readUInt32LE(eocd + 16)

    let cursor = centralOffset
    for (let i = 0; i < 2; i++) {
      expect(zip.readUInt32LE(cursor)).toBe(0x02014b50)
      const nameLen = zip.readUInt16LE(cursor + 28)
      const localOffset = zip.readUInt32LE(cursor + 42)

      // Di posisi yang ditunjuk harus ada header lokal, dengan nama yang sama.
      expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50)
      const namaDiPusat = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
      const namaDiLokal = zip.subarray(localOffset + 30, localOffset + 30 + nameLen).toString('utf8')
      expect(namaDiLokal).toBe(namaDiPusat)

      cursor += 46 + nameLen
    }
  })

  it('CRC dan ukuran di header lokal cocok dengan isinya', () => {
    const zip = buildZip(entries, new Date('2026-09-20T10:00:00'))
    const entry = entries[0]
    expect(entry).toBeDefined()
    if (!entry) return

    expect(zip.readUInt32LE(14)).toBe(crc32(entry.data))
    expect(zip.readUInt32LE(18)).toBe(entry.data.length)
    expect(zip.readUInt32LE(22)).toBe(entry.data.length)
  })

  it('arsip kosong tetap ZIP yang sah', () => {
    const zip = buildZip([], new Date('2026-09-20T10:00:00'))
    expect(zip.length).toBe(22)
    expect(zip.readUInt32LE(0)).toBe(0x06054b50)
  })
})

describe('csvCell', () => {
  it('membungkus nilai yang memuat koma, kutip, atau baris baru', () => {
    expect(csvCell('biasa')).toBe('biasa')
    expect(csvCell('ada,koma')).toBe('"ada,koma"')
    expect(csvCell('ada "kutip"')).toBe('"ada ""kutip"""')
    expect(csvCell('dua\nbaris')).toBe('"dua\nbaris"')
  })

  it('mengosongkan null dan undefined, bukan menulis "null"', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('angka nol tetap ditulis nol', () => {
    // Nol yang hilang mengubah laporan. `0` bukan nilai kosong.
    expect(csvCell(0)).toBe('0')
    expect(csvCell(false)).toBe('false')
  })

  it('menetralkan nilai yang bisa dieksekusi Excel sebagai formula', () => {
    // CSV injection. Nama produk diisi manusia, dan berkas export dibuka di
    // komputer orang lain — sering komputer akuntan.
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('=CMD|"calc"!A1')).toBe('"\'=CMD|""calc""!A1"')
    expect(csvCell('+62812')).toBe("'+62812")
    expect(csvCell('-5')).toBe("'-5")
    expect(csvCell('@formula')).toBe("'@formula")
    // Angka negatif sungguhan TIDAK dinetralkan: ia bertipe number, bukan string.
    // Kolom difference, qtyChange, dan stockAfter memang sering minus, dan kalau
    // ditulis sebagai teks, pemilik tidak bisa menjumlahkannya di Excel.
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(-1500)).toBe('-1500')
    // Tapi string '-5' tetap dinetralkan — di situlah bahayanya ada.
    expect(csvCell('-5')).toBe("'-5")
  })

  it('Date ditulis sebagai ISO, bukan format lokal', () => {
    expect(csvCell(new Date('2026-09-20T03:04:05Z'))).toBe('2026-09-20T03:04:05.000Z')
  })
})

describe('toCsv', () => {
  it('hanya menulis kolom yang diminta, dengan urutan yang diminta', () => {
    // Inilah yang menahan kolom rahasia ikut terbawa: kolom diambil dari daftar
    // eksplisit, bukan dari kunci objeknya.
    const rows = [{ id: '1', nama: 'Kopi', pinHash: 'RAHASIA' }]
    const csv = toCsv(['nama', 'id'] as const, rows)

    expect(csv).toBe('nama,id\r\nKopi,1\r\n')
    expect(csv).not.toContain('RAHASIA')
    expect(csv).not.toContain('pinHash')
  })

  it('baris kosong tetap menghasilkan header', () => {
    expect(toCsv(['a', 'b'] as const, [])).toBe('a,b\r\n')
  })
})

describe('csvRow', () => {
  it('menggabungkan dengan koma', () => {
    expect(csvRow([1, 'dua', null])).toBe('1,dua,')
  })
})
