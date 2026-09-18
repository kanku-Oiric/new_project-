-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePin" BOOLEAN NOT NULL DEFAULT false,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceLabel" TEXT,
    "ip" TEXT,
    CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedByUserId" TEXT
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "nama" TEXT NOT NULL,
    "searchKey" TEXT NOT NULL,
    "kategori" TEXT NOT NULL,
    "hargaBeli" INTEGER NOT NULL,
    "hargaJual" INTEGER NOT NULL,
    "stok" INTEGER NOT NULL DEFAULT 0,
    "stokMinimum" INTEGER NOT NULL DEFAULT 0,
    "satuan" TEXT NOT NULL DEFAULT 'pcs',
    "aktif" BOOLEAN NOT NULL DEFAULT true,
    "gambarPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "qtyChange" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "stockBefore" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "userId" TEXT NOT NULL,
    "note" TEXT,
    "businessDate" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cashierId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "openKey" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "openingCash" INTEGER NOT NULL,
    "countedCash" INTEGER,
    "expectedCash" INTEGER,
    "difference" INTEGER,
    "businessDate" TEXT NOT NULL,
    "notes" TEXT,
    "closedByUserId" TEXT,
    CONSTRAINT "shifts_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trxNumber" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "grossSubtotal" INTEGER NOT NULL,
    "itemDiscountTotal" INTEGER NOT NULL,
    "transactionDiscount" INTEGER NOT NULL,
    "netTotal" INTEGER NOT NULL,
    "cogsTotal" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "voidedAt" DATETIME,
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "cancelReason" TEXT,
    CONSTRAINT "transactions_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "transactions_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transaction_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "unitCost" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "lineGross" INTEGER NOT NULL,
    "itemDiscount" INTEGER NOT NULL DEFAULT 0,
    "allocatedTxDiscount" INTEGER NOT NULL DEFAULT 0,
    "lineNet" INTEGER NOT NULL,
    "lineFinal" INTEGER NOT NULL,
    "refundedQty" INTEGER NOT NULL DEFAULT 0,
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "transaction_items_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transaction_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "amountTendered" INTEGER,
    "changeAmount" INTEGER,
    "providerName" TEXT NOT NULL,
    "externalId" TEXT,
    "qrRef" TEXT,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "confirmedByUserId" TEXT,
    CONSTRAINT "payments_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "refundNumber" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "cogsAmount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorizedByUserId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refunds_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "refunds_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "refund_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "refundId" TEXT NOT NULL,
    "transactionItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "cogsAmount" INTEGER NOT NULL,
    CONSTRAINT "refund_items_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "refund_items_transactionItemId_fkey" FOREIGN KEY ("transactionItemId") REFERENCES "transaction_items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shiftId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "kategori" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "paidFrom" TEXT NOT NULL DEFAULT 'CASH_DRAWER',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "deletedByUserId" TEXT,
    CONSTRAINT "expenses_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "ip" TEXT,
    "deviceLabel" TEXT
);

-- CreateTable
CREATE TABLE "daily_counters" (
    "scope" TEXT NOT NULL PRIMARY KEY,
    "lastSeq" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "requestedByUserId" TEXT,
    "dedupeKey" TEXT
);

-- CreateTable
CREATE TABLE "ai_call_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "businessDate" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "model" TEXT,
    "errorMessage" TEXT
);

-- CreateTable
CREATE TABLE "ai_insights" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "insightJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedByUserId" TEXT
);

-- CreateTable
CREATE TABLE "startup_locks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holder" TEXT NOT NULL,
    "heldAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "users_active_idx" ON "users"("active");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");

-- CreateIndex
CREATE INDEX "products_searchKey_idx" ON "products"("searchKey");

-- CreateIndex
CREATE INDEX "products_kategori_idx" ON "products"("kategori");

-- CreateIndex
CREATE INDEX "products_aktif_idx" ON "products"("aktif");

-- CreateIndex
CREATE INDEX "products_barcode_idx" ON "products"("barcode");

-- CreateIndex
CREATE INDEX "stock_movements_productId_createdAt_idx" ON "stock_movements"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_businessDate_idx" ON "stock_movements"("businessDate");

-- CreateIndex
CREATE INDEX "stock_movements_reason_idx" ON "stock_movements"("reason");

-- CreateIndex
CREATE INDEX "stock_movements_refType_refId_idx" ON "stock_movements"("refType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_openKey_key" ON "shifts"("openKey");

-- CreateIndex
CREATE INDEX "shifts_cashierId_status_idx" ON "shifts"("cashierId", "status");

-- CreateIndex
CREATE INDEX "shifts_businessDate_idx" ON "shifts"("businessDate");

-- CreateIndex
CREATE INDEX "shifts_status_idx" ON "shifts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_trxNumber_key" ON "transactions"("trxNumber");

-- CreateIndex
CREATE INDEX "transactions_businessDate_status_idx" ON "transactions"("businessDate", "status");

-- CreateIndex
CREATE INDEX "transactions_shiftId_idx" ON "transactions"("shiftId");

-- CreateIndex
CREATE INDEX "transactions_createdAt_idx" ON "transactions"("createdAt");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "transaction_items_transactionId_idx" ON "transaction_items"("transactionId");

-- CreateIndex
CREATE INDEX "transaction_items_productId_idx" ON "transaction_items"("productId");

-- CreateIndex
CREATE INDEX "payments_transactionId_idx" ON "payments"("transactionId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_externalId_idx" ON "payments"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refundNumber_key" ON "refunds"("refundNumber");

-- CreateIndex
CREATE INDEX "refunds_transactionId_idx" ON "refunds"("transactionId");

-- CreateIndex
CREATE INDEX "refunds_shiftId_idx" ON "refunds"("shiftId");

-- CreateIndex
CREATE INDEX "refunds_businessDate_idx" ON "refunds"("businessDate");

-- CreateIndex
CREATE INDEX "refund_items_refundId_idx" ON "refund_items"("refundId");

-- CreateIndex
CREATE INDEX "refund_items_transactionItemId_idx" ON "refund_items"("transactionItemId");

-- CreateIndex
CREATE INDEX "expenses_shiftId_idx" ON "expenses"("shiftId");

-- CreateIndex
CREATE INDEX "expenses_businessDate_idx" ON "expenses"("businessDate");

-- CreateIndex
CREATE INDEX "expenses_deletedAt_idx" ON "expenses"("deletedAt");

-- CreateIndex
CREATE INDEX "audit_logs_at_idx" ON "audit_logs"("at");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "report_deliveries_dedupeKey_key" ON "report_deliveries"("dedupeKey");

-- CreateIndex
CREATE INDEX "report_deliveries_status_nextAttemptAt_idx" ON "report_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "report_deliveries_kind_periodKey_channel_trigger_idx" ON "report_deliveries"("kind", "periodKey", "channel", "trigger");

-- CreateIndex
CREATE INDEX "report_deliveries_trigger_status_idx" ON "report_deliveries"("trigger", "status");

-- CreateIndex
CREATE INDEX "ai_call_logs_businessDate_idx" ON "ai_call_logs"("businessDate");

-- CreateIndex
CREATE INDEX "ai_insights_kind_periodKey_createdAt_idx" ON "ai_insights"("kind", "periodKey", "createdAt");

-- CreateIndex
CREATE INDEX "ai_insights_createdAt_idx" ON "ai_insights"("createdAt");
