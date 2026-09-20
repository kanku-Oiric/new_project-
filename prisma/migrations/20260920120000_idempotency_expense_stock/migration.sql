-- Kunci sekali-pakai untuk pengeluaran kas, barang masuk, dan penyesuaian stok.
--
-- Audit integritas transaksi menemukan ketiganya masih bisa menggandakan efek
-- saat request-nya diulang: pengeluaran dobel membuat expected cash shift salah
-- dan kasirnya tampak kehilangan uang, barang masuk dobel menaikkan stok dua
-- kali, penyesuaian dobel menerapkan koreksi yang sama dua kali.
--
-- Penutupannya tertunda satu sesi karena kedua tabel tidak punya SATU PUN kolom
-- unique yang bisa menampung kunci — jadi memang butuh migrasi ini, bukan hanya
-- perubahan kode.
--
-- Nullable dengan sengaja: SQLite mengizinkan banyak NULL pada indeks unique,
-- jadi baris lama tetap sah dan pergerakan stok dari penjualan (reason SALE)
-- tetap boleh kosong. Tidak ada backfill: yang dilindungi adalah pengulangan
-- yang belum terjadi, bukan baris yang sudah tersimpan.

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "expenses" ADD COLUMN "idempotencyFingerprint" TEXT;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "stock_movements" ADD COLUMN "idempotencyFingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "expenses_idempotencyKey_key" ON "expenses"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_idempotencyKey_key" ON "stock_movements"("idempotencyKey");
