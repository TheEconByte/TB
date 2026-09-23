import type { PrismaClient } from '../../generated/prisma/client.ts';
import { fromDate } from './dates.ts';
import { fundingProductSchema, type FundingCatalog, type FundingProduct } from './schema.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';

// The active catalog is read through the release → membership → immutable
// product version chain. The membership table keeps each release's own order,
// so a later release may reuse the same product version without rewriting it.
export type ActiveFundingCatalog = {
  releaseId: string;
  catalogKey: string;
  catalogVersion: string;
  schemaVersion: string;
  basisDate: string;
  reviewedAt: string | null;
  activatedAt: string | null;
  reviewer: string;
  productCount: number;
  // 판정 함수가 그대로 쓰는 카탈로그. 저장된 상품 JSON을 다시 스키마로 검증한다.
  catalog: FundingCatalog;
};

// Only an ACTIVE release is ever served. PENDING, FAILED and SUPERSEDED
// releases stay invisible to the matching API.
export async function findActiveFundingCatalog(prisma: PrismaClient): Promise<ActiveFundingCatalog | null> {
  const release = await prisma.fundingCatalogRelease.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { activatedAt: 'desc' },
    select: {
      id: true,
      catalogKey: true,
      catalogVersion: true,
      schemaVersion: true,
      basisDate: true,
      reviewedAt: true,
      activatedAt: true,
      reviewer: true,
      products: {
        orderBy: { position: 'asc' },
        select: { position: true, productVersion: { select: { productJson: true } } },
      },
    },
  });
  if (!release) return null;
  if (release.schemaVersion !== FUNDING_CATALOG_SCHEMA_VERSION) {
    // 카탈로그를 읽을 수 없는 상태를 빈 후보로 속이지 않는다.
    throw new Error(
      `활성 자금 카탈로그의 스키마 버전(${release.schemaVersion})을 이 앱이 지원하지 않습니다. 카탈로그를 다시 검수해 적재하세요.`,
    );
  }

  // 연결 테이블의 position이 릴리스 순서의 기준이다. 쿼리 정렬에만 의존하지
  // 않도록 여기서도 position 순으로 다시 세운다.
  const ordered = [...release.products].sort((left, right) => left.position - right.position);
  const products: FundingProduct[] = ordered.map((membership) =>
    fundingProductSchema.parse(membership.productVersion.productJson),
  );

  return {
    releaseId: release.id,
    catalogKey: release.catalogKey,
    catalogVersion: release.catalogVersion,
    schemaVersion: release.schemaVersion,
    basisDate: fromDate(release.basisDate),
    reviewedAt: release.reviewedAt === null ? null : fromDate(release.reviewedAt),
    activatedAt: release.activatedAt === null ? null : release.activatedAt.toISOString(),
    reviewer: release.reviewer,
    productCount: products.length,
    catalog: {
      catalogKey: release.catalogKey,
      schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
      catalogVersion: release.catalogVersion,
      basisDate: fromDate(release.basisDate),
      reviewer: release.reviewer,
      // 카탈로그 notes는 릴리스에 저장하지 않는다. 판정에는 쓰이지 않는다.
      notes: [],
      products,
    },
  };
}
