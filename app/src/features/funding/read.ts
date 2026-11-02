import type { PrismaClient } from '../../generated/prisma/client.ts';
import { fromDate } from './dates.ts';
import {
  defaultFundingAutomation,
  fundingAutomationSchema,
  fundingProductSchema,
  type FundingAutomation,
  type FundingCatalog,
  type FundingProduct,
} from './schema.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION, READABLE_FUNDING_CATALOG_SCHEMA_VERSIONS } from './types.ts';

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
  // 자동 승격 스위치·차단 목록·출처별 동기화 결과. v1.0.0 릴리스는 저장된 값이 없어 기본값(모두 꺼짐)이다.
  automation: FundingAutomation;
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
      automation: true,
      products: {
        orderBy: { position: 'asc' },
        select: { position: true, productVersion: { select: { productJson: true } } },
      },
    },
  });
  if (!release) return null;
  if (!READABLE_FUNDING_CATALOG_SCHEMA_VERSIONS.includes(release.schemaVersion)) {
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
  const automation =
    release.automation === null ? defaultFundingAutomation() : fundingAutomationSchema.parse(release.automation);

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
    automation,
    catalog: {
      catalogKey: release.catalogKey,
      schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
      catalogVersion: release.catalogVersion,
      basisDate: fromDate(release.basisDate),
      reviewer: release.reviewer,
      // 카탈로그 notes는 릴리스에 저장하지 않는다. 판정에는 쓰이지 않는다.
      notes: [],
      automation,
      products,
    },
  };
}
