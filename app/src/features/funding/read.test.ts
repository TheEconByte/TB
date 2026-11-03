import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { findActiveFundingCatalog } from './read.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';

const TEST_DATE = '2026-09-20';
const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';

function evidence(id: string, subject: string): Record<string, unknown> {
  return {
    id,
    subject,
    summary: '공식 원문에서 해당 조건을 확인했습니다.',
    sourceUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    observedAt: TEST_DATE,
    retrievalMethod: 'OFFICIAL_WEB_PAGE',
    checksum: null,
  };
}

function product(productKey: string): Record<string, unknown> {
  return {
    productKey,
    version: '1.0.0',
    name: `${productKey} 상품`,
    organization: '테스트 기관',
    supportType: 'LOAN',
    eligibleBusinessStages: ['PRE_REGISTRATION'],
    region: { scope: 'SEOUL', districtCodes: [], note: null },
    purpose: { included: [], excluded: [], note: null },
    industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: null },
    applicationPeriod: { start: '2026-09-01', end: '2026-12-31', note: null },
    observedApplicationStatus: 'OPEN',
    observedAt: TEST_DATE,
    reviewedAt: TEST_DATE,
    nextReviewAt: '2026-10-20',
    officialUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    sourceDocumentRetrieved: false,
    sourceChecksum: null,
    publicLimit: '50000000',
    interestCondition: null,
    interestRateConfirmed: false,
    repaymentCondition: null,
    repaymentMethod: 'UNKNOWN',
    unsupportedCalculationReasons: ['금리가 확정되지 않았습니다.'],
    additionalChecks: [],
    reviewer: 'test-reviewer',
    evidence: [
      evidence('identity', 'IDENTITY'),
      evidence('period', 'APPLICATION_PERIOD'),
      evidence('stage', 'BUSINESS_STAGE'),
      evidence('financial', 'FINANCIAL_CONDITION'),
      evidence('region', 'REGION'),
    ],
  };
}

type StubMembership = { position: number; productVersion: { productJson: unknown } };

// 활성 릴리스 조회만 흉내 내는 Prisma 대역. Prisma가 돌려주는 연결 행 모양(position + 불변 상품 버전)을 따른다.
function stubPrisma(release: { schemaVersion?: string; automation?: unknown; products: StubMembership[] } | null) {
  const findFirst = vi.fn().mockResolvedValue(
    release === null
      ? null
      : {
          id: 'release-1',
          catalogKey: 'test-catalog',
          catalogVersion: '2026-09-20.1',
          schemaVersion: release.schemaVersion ?? FUNDING_CATALOG_SCHEMA_VERSION,
          basisDate: new Date(`${TEST_DATE}T00:00:00.000Z`),
          reviewedAt: new Date(`${TEST_DATE}T00:00:00.000Z`),
          activatedAt: new Date('2026-09-20T03:00:00.000Z'),
          reviewer: 'test-reviewer',
          automation: release.automation ?? null,
          products: release.products,
        },
  );
  return { fundingCatalogRelease: { findFirst } } as unknown as PrismaClient;
}

const membership = (productKey: string, position: number): StubMembership => ({
  position,
  productVersion: { productJson: product(productKey) },
});

describe('활성 카탈로그 읽기', () => {
  it('연결 테이블 position 순서를 보존한다', async () => {
    const prisma = stubPrisma({
      products: [membership('test-third', 2), membership('test-first', 0), membership('test-second', 1)],
    });
    const active = await findActiveFundingCatalog(prisma);
    expect(active?.catalog.products.map((entry) => entry.productKey)).toEqual([
      'test-first',
      'test-second',
      'test-third',
    ]);
  });

  // 화면이 맞춰 본 기준으로 보여 주는 릴리스 정보다. DB의 날짜 열은 한국 시간 날짜(YYYY-MM-DD)로 읽는다.
  it('릴리스 정보와 날짜를 그대로 옮긴다', async () => {
    const active = await findActiveFundingCatalog(stubPrisma({ products: [membership('test-loan', 0)] }));
    expect(active).toMatchObject({
      releaseId: 'release-1',
      catalogKey: 'test-catalog',
      catalogVersion: '2026-09-20.1',
      basisDate: TEST_DATE,
      reviewedAt: TEST_DATE,
      activatedAt: '2026-09-20T03:00:00.000Z',
      reviewer: 'test-reviewer',
      productCount: 1,
    });
    expect(active?.catalog).toMatchObject({
      catalogKey: 'test-catalog',
      catalogVersion: '2026-09-20.1',
      basisDate: TEST_DATE,
    });
  });

  // v1.0.0에는 자동화 설정이 없었다. 그 릴리스는 모두 꺼진 기본값으로 읽는다(docs/domains/funding.md 카탈로그).
  it('v1.0.0 스키마로 적재된 릴리스도 자동화 설정 없이 읽는다', async () => {
    const active = await findActiveFundingCatalog(
      stubPrisma({ schemaVersion: 'funding-catalog-v1.0.0', products: [membership('test-loan', 0)] }),
    );
    expect(active?.schemaVersion).toBe('funding-catalog-v1.0.0');
    expect(active?.catalog.products).toHaveLength(1);
    expect(active?.automation).toEqual({
      policyLoanPromotion: false,
      repaymentPromotion: false,
      blockedSources: [],
      sourceSyncs: [],
    });
  });

  // v1.4.0은 기업마당 지원분야·소진공 대출한도 문장(선택 필드)만 더했다. 그 전 릴리스는 그 필드 없이 읽는다.
  it('v1.3.0 스키마로 적재된 릴리스도 읽는다', async () => {
    const active = await findActiveFundingCatalog(
      stubPrisma({ schemaVersion: 'funding-catalog-v1.3.0', products: [membership('test-loan', 0)] }),
    );
    expect(active?.schemaVersion).toBe('funding-catalog-v1.3.0');
    expect(active?.catalog.products.map((entry) => entry.productKey)).toEqual(['test-loan']);
  });

  it('연결된 상품이 없는 활성 릴리스는 빈 카탈로그로 읽는다', async () => {
    const active = await findActiveFundingCatalog(stubPrisma({ products: [] }));
    expect(active?.productCount).toBe(0);
    expect(active?.catalog.products).toEqual([]);
  });

  it('활성 릴리스가 없으면 null이다', async () => {
    expect(await findActiveFundingCatalog(stubPrisma(null))).toBeNull();
  });
});
