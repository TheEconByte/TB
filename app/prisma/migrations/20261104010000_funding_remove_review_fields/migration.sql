-- ADR 0009 §7: 검수자·검수 기한을 없앤다. 상품 버전의 검수일·다음 검토일은 productJson에 그대로 남는다.
-- 릴리스의 검수자는 커밋된 catalog.json에서 모두 UNASSIGNED였고, 릴리스 검수일은 상품 검수일 중 가장 늦은 날짜였다.

-- DropIndex
DROP INDEX "funding_product_versions_nextReviewAt_idx";

-- AlterTable
ALTER TABLE "funding_catalog_releases" DROP COLUMN "reviewedAt",
DROP COLUMN "reviewer";

-- AlterTable
ALTER TABLE "funding_product_versions" DROP COLUMN "nextReviewAt",
DROP COLUMN "reviewedAt";
