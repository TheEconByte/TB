-- CreateEnum
CREATE TYPE "MarketReleaseStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUPERSEDED', 'FAILED');

-- CreateTable
CREATE TABLE "market_releases" (
    "id" TEXT NOT NULL,
    "releaseKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "MarketReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "schemaVersion" TEXT NOT NULL,
    "definitionVersion" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "basisPeriod" TEXT NOT NULL,
    "basisPeriodLabel" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "files" JSONB NOT NULL,
    "validationSummary" JSONB NOT NULL,
    "areaCount" INTEGER NOT NULL DEFAULT 0,
    "quarterlyRowCount" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_areas" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "areaType" TEXT NOT NULL,
    "areaCode" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "observedName" TEXT,
    "areaTypeName" TEXT NOT NULL,
    "districtCode" TEXT NOT NULL,
    "districtName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "industries" (
    "code" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayNameSource" TEXT NOT NULL,
    "sourceCategoryVersion" TEXT NOT NULL,
    "isSupported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "industries_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "market_quarterly" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "quarter" TEXT NOT NULL,
    "areaType" TEXT NOT NULL,
    "areaCode" TEXT NOT NULL,
    "industryCode" TEXT NOT NULL,
    "salesAmount" DECIMAL(18,0),
    "storeCount" INTEGER,
    "similarIndustryStoreCount" INTEGER,
    "franchiseStoreCount" INTEGER,
    "openedStoreCount" INTEGER,
    "closedStoreCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_quarterly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_releases_releaseKey_key" ON "market_releases"("releaseKey");

-- CreateIndex
CREATE INDEX "market_releases_status_activatedAt_idx" ON "market_releases"("status", "activatedAt");

-- CreateIndex
CREATE INDEX "market_areas_releaseId_districtCode_areaCode_idx" ON "market_areas"("releaseId", "districtCode", "areaCode");

-- CreateIndex
CREATE UNIQUE INDEX "market_areas_releaseId_areaType_areaCode_key" ON "market_areas"("releaseId", "areaType", "areaCode");

-- CreateIndex
CREATE INDEX "industries_isSupported_idx" ON "industries"("isSupported");

-- CreateIndex
CREATE INDEX "market_quarterly_releaseId_areaCode_industryCode_quarter_idx" ON "market_quarterly"("releaseId", "areaCode", "industryCode", "quarter");

-- CreateIndex
CREATE INDEX "market_quarterly_releaseId_industryCode_idx" ON "market_quarterly"("releaseId", "industryCode");

-- CreateIndex
CREATE UNIQUE INDEX "market_quarterly_releaseId_quarter_areaType_areaCode_indust_key" ON "market_quarterly"("releaseId", "quarter", "areaType", "areaCode", "industryCode");

-- AddForeignKey
ALTER TABLE "market_areas" ADD CONSTRAINT "market_areas_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "market_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_quarterly" ADD CONSTRAINT "market_quarterly_releaseId_areaType_areaCode_fkey" FOREIGN KEY ("releaseId", "areaType", "areaCode") REFERENCES "market_areas"("releaseId", "areaType", "areaCode") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_quarterly" ADD CONSTRAINT "market_quarterly_industryCode_fkey" FOREIGN KEY ("industryCode") REFERENCES "industries"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "plan_results_planId_inputRevision_inputSchemaVersion_calculatio" RENAME TO "plan_results_planId_inputRevision_inputSchemaVersion_calcul_key";
