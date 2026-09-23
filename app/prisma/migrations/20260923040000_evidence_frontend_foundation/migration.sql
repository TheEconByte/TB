-- Keep business planning inputs separate from immutable finance inputs/results.
ALTER TABLE "plans" ADD COLUMN "businessProfileJson" JSONB;

-- Extend the verified Seoul sales snapshot with source-provided counts and
-- fixed-schema demographic/time breakdowns. Existing releases stay readable.
ALTER TABLE "market_quarterly"
  ADD COLUMN "salesCount" DECIMAL(18,0),
  ADD COLUMN "salesBreakdownJson" JSONB;

CREATE TYPE "BusinessDirectoryReleaseStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUPERSEDED', 'FAILED');

CREATE TABLE "business_directory_releases" (
  "id" TEXT NOT NULL,
  "releaseKey" TEXT NOT NULL,
  "status" "BusinessDirectoryReleaseStatus" NOT NULL DEFAULT 'PENDING',
  "schemaVersion" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "retrievedAt" TIMESTAMP(3) NOT NULL,
  "sourceChecksum" TEXT NOT NULL,
  "sourceMetadata" JSONB NOT NULL,
  "validationSummary" JSONB NOT NULL,
  "businessCount" INTEGER NOT NULL DEFAULT 0,
  "activatedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_directory_releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_locations" (
  "id" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "sourceBusinessId" TEXT NOT NULL,
  "businessName" TEXT NOT NULL,
  "branchName" TEXT,
  "largeCategoryCode" TEXT NOT NULL,
  "largeCategoryName" TEXT NOT NULL,
  "middleCategoryCode" TEXT NOT NULL,
  "middleCategoryName" TEXT NOT NULL,
  "smallCategoryCode" TEXT NOT NULL,
  "smallCategoryName" TEXT NOT NULL,
  "marketIndustryCode" TEXT,
  "standardIndustryCode" TEXT,
  "standardIndustryName" TEXT,
  "districtCode" TEXT NOT NULL,
  "districtName" TEXT NOT NULL,
  "administrativeDongCode" TEXT,
  "administrativeDongName" TEXT,
  "lotAddress" TEXT,
  "roadAddress" TEXT,
  "longitude" DECIMAL(11,7),
  "latitude" DECIMAL(10,7),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_locations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "business_directory_releases_releaseKey_key" ON "business_directory_releases"("releaseKey");
CREATE INDEX "business_directory_releases_status_activatedAt_idx" ON "business_directory_releases"("status", "activatedAt");
CREATE UNIQUE INDEX "business_locations_releaseId_sourceBusinessId_key" ON "business_locations"("releaseId", "sourceBusinessId");
CREATE INDEX "business_locations_releaseId_districtCode_smallCategoryCode_idx" ON "business_locations"("releaseId", "districtCode", "smallCategoryCode");
CREATE INDEX "business_locations_releaseId_marketIndustryCode_smallCategoryCode_idx" ON "business_locations"("releaseId", "marketIndustryCode", "smallCategoryCode");

ALTER TABLE "business_locations"
  ADD CONSTRAINT "business_locations_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "business_directory_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
