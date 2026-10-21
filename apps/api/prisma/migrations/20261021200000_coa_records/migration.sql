-- CreateEnum
CREATE TYPE "CoaStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AnchorKind" AS ENUM ('PUBLISH', 'REVOKE');

-- CreateEnum
CREATE TYPE "AnchorStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "Coa" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CoaStatus" NOT NULL DEFAULT 'DRAFT',
    "labName" TEXT NOT NULL,
    "labReportId" TEXT NOT NULL,
    "testedAt" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "purityPercent" DECIMAL(5,2) NOT NULL,
    "notes" TEXT,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByAdminId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "revokedByAdminId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "Coa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoaFile" (
    "coaId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,

    CONSTRAINT "CoaFile_pkey" PRIMARY KEY ("coaId")
);

-- CreateTable
CREATE TABLE "CoaAnchor" (
    "id" TEXT NOT NULL,
    "coaId" TEXT NOT NULL,
    "kind" "AnchorKind" NOT NULL,
    "memo" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "txSignature" TEXT,
    "status" "AnchorStatus" NOT NULL DEFAULT 'PENDING',
    "slot" BIGINT,
    "blockTime" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoaAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Coa_fileSha256_idx" ON "Coa"("fileSha256");

-- CreateIndex
CREATE INDEX "Coa_lotId_status_idx" ON "Coa"("lotId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Coa_lotId_version_key" ON "Coa"("lotId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CoaAnchor_txSignature_key" ON "CoaAnchor"("txSignature");

-- CreateIndex
CREATE UNIQUE INDEX "CoaAnchor_coaId_kind_key" ON "CoaAnchor"("coaId", "kind");

-- AddForeignKey
ALTER TABLE "Coa" ADD CONSTRAINT "Coa_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoaFile" ADD CONSTRAINT "CoaFile_coaId_fkey" FOREIGN KEY ("coaId") REFERENCES "Coa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoaAnchor" ADD CONSTRAINT "CoaAnchor_coaId_fkey" FOREIGN KEY ("coaId") REFERENCES "Coa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

