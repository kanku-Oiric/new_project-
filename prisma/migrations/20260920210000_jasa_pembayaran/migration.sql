-- Jasa pembayaran: token listrik, PLN, PDAM, top-up e-wallet, transfer, tarik tunai.
--
-- Toko menjual jasa ini dengan membayar lewat aplikasi lain (Shopee/GoPay).
-- Sistem TIDAK memanggil API provider mana pun — murni pencatatan.
--
-- Dua kolom baru di `transactions` adalah inti seluruh perubahan:
-- `netTotal` TETAP berarti omzet, dan titipan pelanggan disimpan terpisah di
-- `passthroughTotal`. Dengan begitu titipan tidak punya jalur apa pun menuju
-- Gross Sales; ia tidak bisa mencemari omzet karena agregasi laporan memang
-- tidak pernah membacanya. Konsekuensinya yang harus disadari:
-- `Payment.amount` tidak lagi sama dengan `netTotal`, melainkan
-- |netTotal + passthroughTotal| (docs/reporting.md §9).
--
-- Keduanya DEFAULT 0, jadi seluruh transaksi lama tetap sah dan angkanya tidak
-- berubah sedikit pun.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "passthroughTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "transactions" ADD COLUMN "serviceFeeTotal" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "service_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nama" TEXT NOT NULL,
    "jenis" TEXT NOT NULL,
    "saldo" INTEGER NOT NULL DEFAULT 0,
    "urutan" INTEGER NOT NULL DEFAULT 0,
    "aktif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "provider_balance_movements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "amountChange" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "paidFrom" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "userId" TEXT NOT NULL,
    "shiftId" TEXT,
    "businessDate" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "idempotencyFingerprint" TEXT,
    CONSTRAINT "provider_balance_movements_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "service_providers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transaction_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "passthroughAmount" INTEGER NOT NULL,
    "serviceFeeAmount" INTEGER NOT NULL,
    "providerCostAmount" INTEGER NOT NULL DEFAULT 0,
    "customerRef" TEXT,
    "note" TEXT,
    CONSTRAINT "transaction_services_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transaction_services_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "service_providers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "service_providers_nama_key" ON "service_providers"("nama");

-- CreateIndex
CREATE UNIQUE INDEX "provider_balance_movements_idempotencyKey_key" ON "provider_balance_movements"("idempotencyKey");
CREATE INDEX "provider_balance_movements_providerId_createdAt_idx" ON "provider_balance_movements"("providerId", "createdAt");
CREATE INDEX "provider_balance_movements_businessDate_idx" ON "provider_balance_movements"("businessDate");
CREATE INDEX "provider_balance_movements_reason_idx" ON "provider_balance_movements"("reason");
CREATE INDEX "provider_balance_movements_refType_refId_idx" ON "provider_balance_movements"("refType", "refId");

-- CreateIndex
CREATE INDEX "transaction_services_transactionId_idx" ON "transaction_services"("transactionId");
CREATE INDEX "transaction_services_kind_idx" ON "transaction_services"("kind");
