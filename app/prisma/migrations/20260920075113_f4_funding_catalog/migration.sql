-- CreateEnum
CREATE TYPE "FundingCatalogStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUPERSEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FundingSupportType" AS ENUM ('GRANT', 'GUARANTEE', 'LOAN', 'SPACE', 'PROGRAM');

-- CreateEnum
CREATE TYPE "FundingApplicationStatus" AS ENUM ('OPEN', 'CLOSED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "funding_catalog_releases" (
    "id" TEXT NOT NULL,
    "catalogKey" TEXT NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "catalogChecksum" TEXT NOT NULL,
    "status" "FundingCatalogStatus" NOT NULL DEFAULT 'PENDING',
    "schemaVersion" TEXT NOT NULL,
    "basisDate" DATE NOT NULL,
    "reviewer" TEXT NOT NULL,
    "sourceDocuments" JSONB NOT NULL,
    "productVersions" JSONB NOT NULL,
    "validationSummary" JSONB NOT NULL,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_catalog_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_product_versions" (
    "id" TEXT NOT NULL,
    "catalogReleaseId" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "supportType" "FundingSupportType" NOT NULL,
    "observedApplicationStatus" "FundingApplicationStatus" NOT NULL,
    "observedAt" DATE NOT NULL,
    "reviewedAt" DATE,
    "nextReviewAt" DATE,
    "officialUrl" TEXT NOT NULL,
    "publicLimit" DECIMAL(18,0),
    "repaymentCalculationSupported" BOOLEAN NOT NULL DEFAULT false,
    "productJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_product_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "funding_catalog_releases_catalogChecksum_key" ON "funding_catalog_releases"("catalogChecksum");

-- CreateIndex
CREATE INDEX "funding_catalog_releases_status_activatedAt_idx" ON "funding_catalog_releases"("status", "activatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "funding_catalog_releases_catalogKey_catalogVersion_key" ON "funding_catalog_releases"("catalogKey", "catalogVersion");

-- CreateIndex
CREATE INDEX "funding_product_versions_supportType_observedApplicationSta_idx" ON "funding_product_versions"("supportType", "observedApplicationStatus");

-- CreateIndex
CREATE INDEX "funding_product_versions_nextReviewAt_idx" ON "funding_product_versions"("nextReviewAt");

-- CreateIndex
CREATE UNIQUE INDEX "funding_product_versions_productKey_version_key" ON "funding_product_versions"("productKey", "version");

-- AddForeignKey
ALTER TABLE "funding_product_versions" ADD CONSTRAINT "funding_product_versions_catalogReleaseId_fkey" FOREIGN KEY ("catalogReleaseId") REFERENCES "funding_catalog_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
