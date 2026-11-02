-- 자동 승격 스위치·차단 목록·출처별 동기화 결과(ADR 0006). 이전 카탈로그 릴리스는 값이 없어 NULL로 남는다.
-- AlterTable
ALTER TABLE "funding_catalog_releases" ADD COLUMN "automation" JSONB;
