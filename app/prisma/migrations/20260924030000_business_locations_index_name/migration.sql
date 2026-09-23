-- 기존 migration이 만든 인덱스 이름은 PostgreSQL이 63자로 자른 형태라 schema.prisma가 기대하는
-- Prisma 이름과 다르다. 그대로 두면 migrate dev가 새 migration마다 이 이름 변경을 끼워 넣는다.
-- RenameIndex
ALTER INDEX "business_locations_releaseId_marketIndustryCode_smallCategoryCo" RENAME TO "business_locations_releaseId_marketIndustryCode_smallCatego_idx";
