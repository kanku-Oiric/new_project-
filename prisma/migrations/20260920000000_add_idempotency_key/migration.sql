-- Kunci sekali-pakai untuk endpoint yang memindahkan uang.
--
-- Kolomnya nullable dengan sengaja: SQLite mengizinkan banyak NULL pada indeks
-- unique, jadi baris lama dan request tanpa kunci tetap sah, sementara request
-- yang membawa kunci dijaga oleh database — bukan hanya oleh kode aplikasi.
--
-- Tidak ada backfill. Transaksi yang sudah ada tidak punya kunci dan tidak
-- membutuhkannya; yang dilindungi adalah pengulangan request yang belum terjadi.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "transactions" ADD COLUMN "idempotencyFingerprint" TEXT;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "refunds" ADD COLUMN "idempotencyFingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotencyKey_key" ON "transactions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotencyKey_key" ON "refunds"("idempotencyKey");
