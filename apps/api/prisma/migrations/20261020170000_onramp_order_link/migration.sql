-- AlterTable
ALTER TABLE "OnRampIntent" ADD COLUMN     "orderId" TEXT;

-- CreateIndex
CREATE INDEX "OnRampIntent_customerId_orderId_status_idx" ON "OnRampIntent"("customerId", "orderId", "status");

