-- Rebuild the industry registry so metadata belongs to one market release.
-- This prevents a PENDING or FAILED release from changing the metadata served
-- with the current ACTIVE release.
ALTER TABLE "market_quarterly" DROP CONSTRAINT "market_quarterly_industryCode_fkey";

CREATE TABLE "industries_by_release" (
    "releaseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayNameSource" TEXT NOT NULL,
    "sourceCategoryVersion" TEXT NOT NULL,
    "isSupported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "industries_by_release_pkey" PRIMARY KEY ("releaseId", "code")
);

INSERT INTO "industries_by_release" (
    "releaseId", "code", "sourceName", "displayName", "displayNameSource",
    "sourceCategoryVersion", "isSupported", "createdAt", "updatedAt"
)
SELECT DISTINCT
    r."id", i."code", i."sourceName", i."displayName", i."displayNameSource",
    i."sourceCategoryVersion", i."isSupported", i."createdAt", i."updatedAt"
FROM "market_releases" r
CROSS JOIN "industries" i;

DROP TABLE "industries";
ALTER TABLE "industries_by_release" RENAME TO "industries";

CREATE INDEX "industries_releaseId_isSupported_idx" ON "industries"("releaseId", "isSupported");

ALTER TABLE "industries"
ADD CONSTRAINT "industries_releaseId_fkey"
FOREIGN KEY ("releaseId") REFERENCES "market_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "market_quarterly"
ADD CONSTRAINT "market_quarterly_releaseId_industryCode_fkey"
FOREIGN KEY ("releaseId", "industryCode") REFERENCES "industries"("releaseId", "code") ON DELETE CASCADE ON UPDATE CASCADE;
