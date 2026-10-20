-- CreateEnum
CREATE TYPE "EligibilityStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "CustomerEligibility" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "EligibilityStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "CustomerEligibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEligibility_customerId_key" ON "CustomerEligibility"("customerId");

-- AddForeignKey
ALTER TABLE "CustomerEligibility" ADD CONSTRAINT "CustomerEligibility_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

