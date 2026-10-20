-- CreateEnum
CREATE TYPE "OnRampStatus" AS ENUM ('CREATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CryptoTxType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'PURCHASE', 'REFUND');

-- CreateEnum
CREATE TYPE "CryptoTxStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateTable
CREATE TABLE "CustomerWallet" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "amountAtomic" BIGINT NOT NULL,
    "slot" BIGINT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnRampIntent" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "OnRampStatus" NOT NULL DEFAULT 'CREATED',
    "intendedUsdCents" INTEGER NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "externalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnRampIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoTransaction" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "CryptoTxType" NOT NULL,
    "status" "CryptoTxStatus" NOT NULL DEFAULT 'PREPARED',
    "amountAtomic" BIGINT NOT NULL,
    "feeLamports" BIGINT,
    "sourceAddress" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "orderId" TEXT,
    "txSignature" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "CryptoTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditReservation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountAtomic" BIGINT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegatedPermission" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "merchantAddress" TEXT NOT NULL,
    "capAtomic" BIGINT NOT NULL,
    "spentAtomic" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DelegatedPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAuditEvent" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerWallet_customerId_key" ON "CustomerWallet"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerWallet_address_key" ON "CustomerWallet"("address");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_walletId_observedAt_idx" ON "BalanceSnapshot"("walletId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OnRampIntent_externalReference_key" ON "OnRampIntent"("externalReference");

-- CreateIndex
CREATE INDEX "OnRampIntent_customerId_createdAt_idx" ON "OnRampIntent"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoTransaction_reference_key" ON "CryptoTransaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoTransaction_txSignature_key" ON "CryptoTransaction"("txSignature");

-- CreateIndex
CREATE INDEX "CryptoTransaction_customerId_createdAt_idx" ON "CryptoTransaction"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CryptoTransaction_status_idx" ON "CryptoTransaction"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_orderId_key" ON "CreditReservation"("orderId");

-- CreateIndex
CREATE INDEX "CreditReservation_customerId_status_idx" ON "CreditReservation"("customerId", "status");

-- CreateIndex
CREATE INDEX "DelegatedPermission_walletId_idx" ON "DelegatedPermission"("walletId");

-- CreateIndex
CREATE INDEX "WalletAuditEvent_customerId_createdAt_idx" ON "WalletAuditEvent"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerWallet" ADD CONSTRAINT "CustomerWallet_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CustomerWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnRampIntent" ADD CONSTRAINT "OnRampIntent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoTransaction" ADD CONSTRAINT "CryptoTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedPermission" ADD CONSTRAINT "DelegatedPermission_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CustomerWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

