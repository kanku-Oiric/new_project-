import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * Seed data awal.
 *
 * IDEMPOTEN: dijalankan dua kali tidak membuat duplikat. Upsert berdasarkan
 * `sku` untuk produk dan `name` untuk user.
 *
 * PIN di sini adalah PIN PENGEMBANGAN. Semua user ditandai `mustChangePin`,
 * dan aplikasi menampilkan peringatan sampai PIN diganti.
 */

const prisma = new PrismaClient()

const BCRYPT_ROUNDS = 10

const USERS = [
  { name: 'Pemilik', role: 'OWNER', pin: '246810' },
  { name: 'Kasir Budi', role: 'CASHIER', pin: '111213' },
  { name: 'Kasir Sari', role: 'CASHIER', pin: '141516' },
] as const

interface SeedProduct {
  sku: string
  barcode: string | null
  nama: string
  kategori: string
  hargaBeli: number
  hargaJual: number
  stok: number
  stokMinimum: number
  satuan: string
}

/** Harga dalam rupiah penuh. hargaBeli selalu < hargaJual. */
const PRODUCTS: SeedProduct[] = [
  // Minuman
  { sku: 'MIN-001', barcode: '8992761111014', nama: 'Aqua Botol 600ml', kategori: 'Minuman', hargaBeli: 2800, hargaJual: 4000, stok: 48, stokMinimum: 12, satuan: 'botol' },
  { sku: 'MIN-002', barcode: '8992753100017', nama: 'Teh Botol Sosro 450ml', kategori: 'Minuman', hargaBeli: 3800, hargaJual: 5500, stok: 36, stokMinimum: 12, satuan: 'botol' },
  { sku: 'MIN-003', barcode: '8886008101053', nama: 'Kopi Kapal Api Sachet', kategori: 'Minuman', hargaBeli: 1200, hargaJual: 2000, stok: 120, stokMinimum: 24, satuan: 'sachet' },
  { sku: 'MIN-004', barcode: '8998009010019', nama: 'Susu Ultra Coklat 250ml', kategori: 'Minuman', hargaBeli: 5200, hargaJual: 7000, stok: 24, stokMinimum: 6, satuan: 'kotak' },
  { sku: 'MIN-005', barcode: null, nama: 'Es Teh Manis Gelas', kategori: 'Minuman', hargaBeli: 1500, hargaJual: 3000, stok: 40, stokMinimum: 10, satuan: 'gelas' },

  // Makanan ringan
  { sku: 'SNK-001', barcode: '8992775111017', nama: 'Chitato Sapi Panggang 68g', kategori: 'Makanan Ringan', hargaBeli: 8500, hargaJual: 11000, stok: 20, stokMinimum: 6, satuan: 'bungkus' },
  { sku: 'SNK-002', barcode: '8992745122015', nama: 'Taro Net Seaweed 40g', kategori: 'Makanan Ringan', hargaBeli: 4200, hargaJual: 6000, stok: 30, stokMinimum: 8, satuan: 'bungkus' },
  { sku: 'SNK-003', barcode: '8993175533018', nama: 'Oreo Original 133g', kategori: 'Makanan Ringan', hargaBeli: 7800, hargaJual: 10500, stok: 18, stokMinimum: 6, satuan: 'bungkus' },
  { sku: 'SNK-004', barcode: '8992388101014', nama: 'Roma Kelapa 300g', kategori: 'Makanan Ringan', hargaBeli: 9500, hargaJual: 13000, stok: 15, stokMinimum: 4, satuan: 'bungkus' },
  { sku: 'SNK-005', barcode: null, nama: 'Kacang Garuda 80g', kategori: 'Makanan Ringan', hargaBeli: 3800, hargaJual: 5500, stok: 25, stokMinimum: 8, satuan: 'bungkus' },

  // Sembako
  { sku: 'SMB-001', barcode: '8992222100011', nama: 'Beras Pandan Wangi 5kg', kategori: 'Sembako', hargaBeli: 68000, hargaJual: 78000, stok: 12, stokMinimum: 3, satuan: 'karung' },
  { sku: 'SMB-002', barcode: '8992222200018', nama: 'Minyak Goreng Bimoli 1L', kategori: 'Sembako', hargaBeli: 16500, hargaJual: 19500, stok: 24, stokMinimum: 6, satuan: 'botol' },
  { sku: 'SMB-003', barcode: '8992222300015', nama: 'Gula Pasir 1kg', kategori: 'Sembako', hargaBeli: 14000, hargaJual: 17000, stok: 20, stokMinimum: 5, satuan: 'kg' },
  { sku: 'SMB-004', barcode: '8998866200014', nama: 'Indomie Goreng', kategori: 'Sembako', hargaBeli: 2700, hargaJual: 3500, stok: 200, stokMinimum: 40, satuan: 'bungkus' },
  { sku: 'SMB-005', barcode: '8998866100017', nama: 'Telur Ayam', kategori: 'Sembako', hargaBeli: 26000, hargaJual: 31000, stok: 15, stokMinimum: 4, satuan: 'kg' },
  { sku: 'SMB-006', barcode: '8992222400012', nama: 'Tepung Terigu Segitiga 1kg', kategori: 'Sembako', hargaBeli: 11000, hargaJual: 13500, stok: 18, stokMinimum: 5, satuan: 'kg' },

  // Kebutuhan rumah
  { sku: 'RMH-001', barcode: '8999999510016', nama: 'Sabun Lifebuoy 110g', kategori: 'Kebutuhan Rumah', hargaBeli: 3500, hargaJual: 5000, stok: 30, stokMinimum: 8, satuan: 'batang' },
  { sku: 'RMH-002', barcode: '8999999520015', nama: 'Rinso Cair 800ml', kategori: 'Kebutuhan Rumah', hargaBeli: 18000, hargaJual: 22500, stok: 14, stokMinimum: 4, satuan: 'botol' },
  { sku: 'RMH-003', barcode: '8999999530014', nama: 'Pepsodent 190g', kategori: 'Kebutuhan Rumah', hargaBeli: 12500, hargaJual: 16000, stok: 16, stokMinimum: 4, satuan: 'tube' },
  { sku: 'RMH-004', barcode: null, nama: 'Gas LPG 3kg (isi ulang)', kategori: 'Kebutuhan Rumah', hargaBeli: 19000, hargaJual: 23000, stok: 8, stokMinimum: 2, satuan: 'tabung' },
]

function buildSearchKey(p: { nama: string; sku: string; barcode: string | null }): string {
  return [p.nama, p.sku, p.barcode ?? ''].join(' ').toLowerCase().trim()
}

function toBusinessDate(instant: Date, tz = 'Asia/Jakarta'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

async function main(): Promise<void> {
  const now = new Date()
  const businessDate = toBusinessDate(now)

  // ── Users ──────────────────────────────────────────────────────────────
  const userIds = new Map<string, string>()
  for (const u of USERS) {
    const existing = await prisma.user.findFirst({ where: { name: u.name } })
    if (existing) {
      userIds.set(u.name, existing.id)
      continue
    }
    const created = await prisma.user.create({
      data: {
        name: u.name,
        role: u.role,
        pinHash: await bcrypt.hash(u.pin, BCRYPT_ROUNDS),
        mustChangePin: true,
      },
    })
    userIds.set(u.name, created.id)
  }

  const ownerId = userIds.get('Pemilik')
  if (!ownerId) throw new Error('seed: user Pemilik gagal dibuat')

  // ── Produk ─────────────────────────────────────────────────────────────
  let createdProducts = 0
  for (const p of PRODUCTS) {
    const existing = await prisma.product.findUnique({ where: { sku: p.sku } })
    if (existing) continue

    // Produk dan pergerakan stok awalnya dibuat dalam satu transaction supaya
    // invariant #10 (stok == Σ qtyChange) berlaku sejak baris pertama, bukan
    // sesuatu yang baru benar setelah transaksi pertama.
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: p.sku,
          barcode: p.barcode,
          nama: p.nama,
          searchKey: buildSearchKey(p),
          kategori: p.kategori,
          hargaBeli: p.hargaBeli,
          hargaJual: p.hargaJual,
          stok: p.stok,
          stokMinimum: p.stokMinimum,
          satuan: p.satuan,
          aktif: true,
        },
      })

      await tx.stockMovement.create({
        data: {
          productId: product.id,
          qtyChange: p.stok,
          reason: 'INITIAL',
          stockBefore: 0,
          stockAfter: p.stok,
          refType: 'MANUAL',
          userId: ownerId,
          note: 'Stok awal dari seed',
          businessDate,
        },
      })
    })
    createdProducts++
  }

  // ── Settings ───────────────────────────────────────────────────────────
  const SETTING_DEFAULTS: Record<string, string> = {
    storeName: 'Toko Saya',
    storeAddress: '',
    storePhone: '',
    receiptFooter: 'Terima kasih',
    receiptWidth: '80',
    timezone: 'Asia/Jakarta',
    installDate: businessDate,
    qrisEnabled: 'false',
    qrisImagePath: '',
    discordWebhookUrl: '',
    telegramBotToken: '',
    telegramChatId: '',
    reportDailyTime: '21:00',
    reportWeeklyDay: '1',
    reportMonthlyDay: '1',
    catchUpMaxPeriods: '60',
    lowStockAlert: 'true',
    expenseCategories: JSON.stringify(['Operasional', 'Listrik', 'Sewa', 'Gaji', 'Lain-lain']),
  }

  let createdSettings = 0
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    const existing = await prisma.setting.findUnique({ where: { key } })
    if (!existing) {
      await prisma.setting.create({ data: { key, value } })
      createdSettings++
    }
  }

  // ── Provider jasa pembayaran ───────────────────────────────────────────
  //
  // Saldo awal NOL dengan sengaja. Angka saldo adalah uang sungguhan yang duduk
  // di aplikasi milik toko; mengisinya dengan angka contoh akan membuat
  // rekonsiliasi pertama menunjukkan selisih yang tidak pernah terjadi.
  const PROVIDERS = [
    { nama: 'Shopee', jenis: 'EWALLET', urutan: 1 },
    { nama: 'GoPay', jenis: 'EWALLET', urutan: 2 },
    { nama: 'Dana', jenis: 'EWALLET', urutan: 3 },
  ]

  let createdProviders = 0
  for (const p of PROVIDERS) {
    const existing = await prisma.serviceProvider.findUnique({ where: { nama: p.nama } })
    if (!existing) {
      await prisma.serviceProvider.create({ data: { ...p, saldo: 0 } })
      createdProviders++
    }
  }

  const totalProducts = await prisma.product.count()
  const totalUsers = await prisma.user.count()

  console.log('')
  console.log('  Seed selesai.')
  console.log(`    User      : ${totalUsers} total`)
  console.log(`    Produk    : ${totalProducts} total (${createdProducts} baru)`)
  console.log(`    Settings  : ${createdSettings} baru`)
  console.log(`    Provider  : ${createdProviders} baru (saldo 0 — isi lewat halaman Saldo)`)
  console.log('')
  console.log('  PIN PENGEMBANGAN — WAJIB DIGANTI sebelum dipakai di toko:')
  for (const u of USERS) {
    console.log(`    ${u.name.padEnd(12)} ${u.role.padEnd(8)} PIN ${u.pin}`)
  }
  console.log('')
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e: unknown) => {
    console.error('Seed GAGAL:', e)
    await prisma.$disconnect()
    process.exit(1)
  })
