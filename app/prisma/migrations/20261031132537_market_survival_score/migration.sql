-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "marketScoreJson" JSONB;

-- CreateTable
CREATE TABLE "market_score_releases" (
    "id" TEXT NOT NULL,
    "releaseKey" TEXT NOT NULL,
    "status" "MarketReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "modelVersion" TEXT NOT NULL,
    "modelChecksum" TEXT NOT NULL,
    "modelJson" JSONB NOT NULL,
    "marketReleaseId" TEXT NOT NULL,
    "marketReleaseKey" TEXT NOT NULL,
    "baseQuarter" TEXT NOT NULL,
    "summaryJson" JSONB NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_score_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_scores" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "industryCode" TEXT NOT NULL,
    "areaType" TEXT NOT NULL,
    "areaCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "storeCount" INTEGER,
    "score" INTEGER,
    "grade" TEXT,
    "probability" DOUBLE PRECISION,
    "rank" INTEGER,
    "monthlyRevenueDefault" DECIMAL(18,0),
    "detailJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_score_releases_releaseKey_key" ON "market_score_releases"("releaseKey");

-- CreateIndex
CREATE INDEX "market_score_releases_status_activatedAt_idx" ON "market_score_releases"("status", "activatedAt");

-- CreateIndex
CREATE INDEX "market_scores_releaseId_industryCode_score_idx" ON "market_scores"("releaseId", "industryCode", "score");

-- CreateIndex
CREATE UNIQUE INDEX "market_scores_releaseId_industryCode_areaType_areaCode_key" ON "market_scores"("releaseId", "industryCode", "areaType", "areaCode");

-- AddForeignKey
ALTER TABLE "market_scores" ADD CONSTRAINT "market_scores_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "market_score_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
