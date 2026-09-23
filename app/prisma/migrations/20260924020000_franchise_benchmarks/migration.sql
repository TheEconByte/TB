-- CreateEnum
CREATE TYPE "FranchiseReleaseStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUPERSEDED', 'FAILED');

-- CreateTable
CREATE TABLE "franchise_releases" (
    "id" TEXT NOT NULL,
    "releaseKey" TEXT NOT NULL,
    "status" "FranchiseReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "schemaVersion" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "basisYears" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "startupCostsIncluded" BOOLEAN NOT NULL,
    "sourceTables" JSONB NOT NULL,
    "validationSummary" JSONB NOT NULL,
    "brandCount" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "franchise_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "franchise_brand_stats" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "disclosureYear" INTEGER NOT NULL,
    "corpName" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "industryLarge" TEXT NOT NULL,
    "industryMiddle" TEXT NOT NULL,
    "marketIndustryCode" TEXT NOT NULL,
    "storeCount" INTEGER NOT NULL,
    "newStoreCount" INTEGER NOT NULL,
    "contractEndCount" INTEGER NOT NULL,
    "contractCancelCount" INTEGER NOT NULL,
    "ownershipChangeCount" INTEGER NOT NULL,
    "averageSalesThousand" DECIMAL(18,0),
    "averageSalesPerAreaThousand" DECIMAL(18,0),
    "franchiseFeeThousand" DECIMAL(18,0),
    "educationFeeThousand" DECIMAL(18,0),
    "depositThousand" DECIMAL(18,0),
    "otherCostThousand" DECIMAL(18,0),
    "startupTotalThousand" DECIMAL(18,0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "franchise_brand_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "franchise_releases_releaseKey_key" ON "franchise_releases"("releaseKey");

-- CreateIndex
CREATE INDEX "franchise_releases_status_activatedAt_idx" ON "franchise_releases"("status", "activatedAt");

-- CreateIndex
CREATE INDEX "franchise_brand_stats_releaseId_marketIndustryCode_disclosu_idx" ON "franchise_brand_stats"("releaseId", "marketIndustryCode", "disclosureYear");

-- CreateIndex
CREATE UNIQUE INDEX "franchise_brand_stats_releaseId_disclosureYear_corpName_bra_key" ON "franchise_brand_stats"("releaseId", "disclosureYear", "corpName", "brandName", "industryMiddle");

-- AddForeignKey
ALTER TABLE "franchise_brand_stats" ADD CONSTRAINT "franchise_brand_stats_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "franchise_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
