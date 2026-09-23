-- CreateEnum
CREATE TYPE "RentBenchmarkReleaseStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUPERSEDED', 'FAILED');

-- CreateTable
CREATE TABLE "rent_benchmark_releases" (
    "id" TEXT NOT NULL,
    "releaseKey" TEXT NOT NULL,
    "status" "RentBenchmarkReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "schemaVersion" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "basisPeriod" TEXT NOT NULL,
    "basisPeriodLabel" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "sourceTables" JSONB NOT NULL,
    "validationSummary" JSONB NOT NULL,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rent_benchmark_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rent_benchmark_observations" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "buildingType" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "quarter" TEXT NOT NULL,
    "regionPath" TEXT NOT NULL,
    "regionName" TEXT NOT NULL,
    "regionLevel" INTEGER NOT NULL,
    "floor" TEXT NOT NULL,
    "value" DECIMAL(24,12),
    "unit" TEXT NOT NULL,
    "sourceTableId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rent_benchmark_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rent_benchmark_releases_releaseKey_key" ON "rent_benchmark_releases"("releaseKey");

-- CreateIndex
CREATE INDEX "rent_benchmark_releases_status_activatedAt_idx" ON "rent_benchmark_releases"("status", "activatedAt");

-- CreateIndex
CREATE INDEX "rent_benchmark_observations_releaseId_buildingType_regionPa_idx" ON "rent_benchmark_observations"("releaseId", "buildingType", "regionPath");

-- CreateIndex
CREATE UNIQUE INDEX "rent_benchmark_observations_releaseId_buildingType_metric_q_key" ON "rent_benchmark_observations"("releaseId", "buildingType", "metric", "quarter", "regionPath", "floor");

-- AddForeignKey
ALTER TABLE "rent_benchmark_observations" ADD CONSTRAINT "rent_benchmark_observations_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "rent_benchmark_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
