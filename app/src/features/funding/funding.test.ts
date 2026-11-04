import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { loadFundingCatalog, readFundingCatalogFile } from './loader.ts';
import { productVersionKey, type FundingCatalog } from './schema.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';
import {
  FundingCatalogError,
  repaymentCalculationReasons,
  validateFundingCatalog,
  type FundingCatalogValidation,
} from './validation.ts';

const REAL_CATALOG_PATH = fileURLToPath(new URL('../../../catalog/funding/catalog.json', import.meta.url));
const REAL_CATALOG = JSON.parse(readFileSync(REAL_CATALOG_PATH, 'utf8')) as unknown;
const REVIEW_DATE = '2026-09-20';
const CREATED_DIRS: string[] = [];

function writeCatalogFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'trendbench-funding-'));
  CREATED_DIRS.push(dir);
  const path = join(dir, 'catalog.json');
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
}

const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';

function evidence(id: string, subject: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    subject,
    summary: '공식 원문에서 해당 조건을 확인했습니다.',
    sourceUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    observedAt: REVIEW_DATE,
    retrievalMethod: 'OFFICIAL_WEB_PAGE',
    checksum: null,
    ...overrides,
  };
}

const BASE_PRODUCT: Record<string, unknown> = {
  productKey: 'test-loan',
  version: '1.0.0',
  name: '테스트 대출 상품',
  organization: '테스트 기관',
  supportType: 'LOAN',
  eligibleBusinessStages: ['PRE_REGISTRATION'],
  region: { scope: 'SEOUL', districtCodes: [], note: null },
  purpose: { included: ['OPERATING_FUNDS'], excluded: [], note: null },
  industryConditions: { scope: 'UNRESTRICTED', included: [], excluded: [], note: null },
  applicationPeriod: { start: '2026-09-01', end: '2026-12-31', note: null },
  observedApplicationStatus: 'OPEN',
  observedAt: REVIEW_DATE,
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
  origin: 'OPERATOR',
  evidence: [
    evidence('identity', 'IDENTITY'),
    evidence('period', 'APPLICATION_PERIOD'),
    evidence('stage', 'BUSINESS_STAGE'),
    evidence('financial', 'FINANCIAL_CONDITION'),
    evidence('region', 'REGION'),
    evidence('purpose', 'PURPOSE'),
    evidence('industry', 'INDUSTRY'),
  ],
};

function product(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_PRODUCT, ...overrides };
}

function catalog(
  products: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    catalogKey: 'test-catalog',
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    catalogVersion: '2026-09-20.1',
    basisDate: REVIEW_DATE,
    notes: [],
    products,
    ...overrides,
  };
}

function validate(raw: unknown): FundingCatalogValidation {
  return validateFundingCatalog(raw);
}

function issueCodes(validation: FundingCatalogValidation): string[] {
  return validation.issues.map((issue) => issue.code);
}

function warningCodes(validation: FundingCatalogValidation): string[] {
  return validation.warnings.map((issue) => issue.code);
}

function catalogFrom(validation: FundingCatalogValidation): FundingCatalog {
  if (validation.catalog === null) throw new Error('검증된 카탈로그가 없습니다.');
  return validation.catalog;
}

// 실제 카탈로그를 테스트 키로 복사한다. 테스트 DB에서 지울 수 있게 catalogKey와 productKey 앞에 test-를 붙인다.
function copiedCatalogFile(): string {
  const source = JSON.parse(readFileSync(REAL_CATALOG_PATH, 'utf8')) as {
    products: Array<Record<string, unknown> & { productKey: string }>;
  };
  return writeCatalogFile({
    ...source,
    catalogKey: 'test-copied-catalog',
    products: source.products.map((entry) => ({ ...entry, productKey: `test-${entry.productKey}` })),
  });
}

function firstProduct(validation: FundingCatalogValidation, productKey = 'test-loan') {
  const found = catalogFrom(validation).products.find((entry) => entry.productKey === productKey);
  if (!found) throw new Error('상품을 찾지 못했습니다: ' + productKey);
  return found;
}

afterAll(() => {
  for (const dir of CREATED_DIRS) rmSync(dir, { recursive: true, force: true });
});

describe('funding catalog schema and rules', () => {
  it('accepts a reviewed product with every required rule satisfied', () => {
    const validation = validate(catalog([product()]));
    expect(validation.ok).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.checks.every((check) => check.status === 'PASS')).toBe(true);
    expect(firstProduct(validation).publicLimit).toBe('50000000');
  });

  it('rejects a duplicate productKey + version', () => {
    const validation = validate(catalog([product(), product()]));
    expect(validation.ok).toBe(false);
    expect(issueCodes(validation)).toContain('DUPLICATE_PRODUCT_VERSION');
  });

  it('rejects a closed notice that is still marked OPEN', () => {
    const closed = product({
      applicationPeriod: { start: '2026-03-01', end: '2026-03-26', note: null },
      observedApplicationStatus: 'OPEN',
    });
    const validation = validate(catalog([closed]));
    expect(validation.ok).toBe(false);
    expect(issueCodes(validation)).toContain('OBSERVED_OPEN_AFTER_PERIOD_END');
  });

  it('rejects a search-result or press URL as the official source', () => {
    const urls = ['https://blog.naver.com/example/1', 'http://www.bizinfo.go.kr/x', 'https://news.example.com/1'];
    for (const url of urls) {
      const validation = validate(catalog([product({ officialUrl: url })]));
      expect(validation.ok).toBe(false);
      expect(issueCodes(validation)).toContain('SCHEMA_INVALID');
    }
  });

  it('requires a checksum only when the original document was retrieved', () => {
    const missing = validate(catalog([product({ sourceDocumentRetrieved: true, sourceChecksum: null })]));
    expect(issueCodes(missing)).toContain('CHECKSUM_MISSING');

    const unexpected = validate(catalog([product({ sourceDocumentRetrieved: false, sourceChecksum: 'a'.repeat(64) })]));
    expect(issueCodes(unexpected)).toContain('CHECKSUM_NOT_RETRIEVED');
  });

  it('rejects lending terms on a grant and a grant without a calculation reason', () => {
    const grant = {
      supportType: 'GRANT',
      repaymentMethod: 'NOT_APPLICABLE',
      interestCondition: '연 2%',
      unsupportedCalculationReasons: [],
    };
    const validation = validate(catalog([product(grant)]));
    expect(validation.ok).toBe(false);
    expect(issueCodes(validation)).toContain('SUPPORT_TYPE_FINANCIAL_CONTRADICTION');
    expect(issueCodes(validation)).toContain('CALCULATION_REASON_MISSING');
  });

  it('rejects structured lending terms on a grant and a rate value that is not marked confirmed', () => {
    const grant = product({
      supportType: 'GRANT',
      repaymentMethod: 'NOT_APPLICABLE',
      interestCondition: null,
      interestRateConfirmed: false,
      interestRatePercent: '3',
      repaymentTermMonths: 60,
      repaymentGraceMonths: 0,
    });
    expect(issueCodes(validate(catalog([grant])))).toContain('SUPPORT_TYPE_FINANCIAL_CONTRADICTION');

    const notConfirmed = validate(catalog([product({ interestRatePercent: '3' })]));
    expect(issueCodes(notConfirmed)).toContain('INTEREST_RATE_NOT_CONFIRMED');

    const unexpectedReason = validate(
      catalog([
        product({
          repaymentMethod: 'EQUAL_INSTALLMENT',
          interestCondition: '연 3% 고정',
          interestRateConfirmed: true,
          interestRatePercent: '3',
          repaymentCondition: '5년 원리금균등, 거치 없음',
          repaymentTermMonths: 60,
          repaymentGraceMonths: 0,
          unsupportedCalculationReasons: ['보증료는 별도입니다.'],
        }),
      ]),
    );
    expect(issueCodes(unexpectedReason)).toContain('CALCULATION_REASON_UNEXPECTED');
  });

  it('accepts a loan with every structured term confirmed as a repayment target', () => {
    const validation = validate(
      catalog([
        product({
          repaymentMethod: 'EQUAL_PRINCIPAL',
          interestCondition: '연 4.5% 고정',
          interestRateConfirmed: true,
          interestRatePercent: '4.5',
          repaymentCondition: '60개월 원금균등, 6개월 거치',
          repaymentTermMonths: 60,
          repaymentGraceMonths: 6,
          unsupportedCalculationReasons: [],
        }),
      ]),
    );
    expect(validation.ok).toBe(true);
    expect(repaymentCalculationReasons(firstProduct(validation))).toEqual([]);
  });

  it('requires official evidence for the identity, period and stage claims', () => {
    const withoutStage = product({
      evidence: [evidence('identity', 'IDENTITY'), evidence('period', 'APPLICATION_PERIOD')],
    });
    const validation = validate(catalog([withoutStage]));
    expect(issueCodes(validation)).toContain('MISSING_EVIDENCE');
  });

  // 맞춰 보기는 자동/사람 상품을 이 값으로 가른다(갈래·운영자 확인 값·출처 최신성·운영자 숨김). 빠진 값을 사람 상품으로
  // 짐작하지 않는다(AGENTS.md §3의 2번).
  it('rejects a product that does not say whether funding:sync or an operator recorded it', () => {
    const withoutOrigin = product();
    delete withoutOrigin.origin;
    const validation = validate(catalog([withoutOrigin]));
    expect(validation.ok).toBe(false);
    expect(issueCodes(validation)).toContain('SCHEMA_INVALID');
    expect(validate(catalog([product({ origin: 'REVIEWER' })])).ok).toBe(false);
  });

  it('rejects an application period that ends before it starts', () => {
    const validation = validate(
      catalog([product({ applicationPeriod: { start: '2026-09-30', end: '2026-09-01', note: null } })]),
    );
    expect(issueCodes(validation)).toContain('APPLICATION_PERIOD_CONTRADICTION');
  });

  it('flags conditions that are only backed by a search-result summary', () => {
    const summaryOnly = product({
      evidence: [
        evidence('identity', 'IDENTITY', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
        evidence('period', 'APPLICATION_PERIOD', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
        evidence('stage', 'BUSINESS_STAGE', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
        evidence('financial', 'FINANCIAL_CONDITION', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
        evidence('region', 'REGION', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
        evidence('purpose', 'PURPOSE', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
        evidence('industry', 'INDUSTRY', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
      ],
    });
    const validation = validate(catalog([summaryOnly]));
    expect(validation.ok).toBe(true);
    expect(warningCodes(validation)).toContain('EVIDENCE_NOT_PRIMARY');
  });

  it('rejects a missing required field', () => {
    const broken = product();
    delete broken.sourceDocumentName;
    const validation = validate(catalog([broken]));
    expect(validation.ok).toBe(false);
    expect(issueCodes(validation)).toContain('SCHEMA_INVALID');
  });

  it('requires evidence for every condition that can produce PASS or FAIL', () => {
    const withoutConditionEvidence = product({
      evidence: [
        evidence('identity', 'IDENTITY'),
        evidence('period', 'APPLICATION_PERIOD'),
        evidence('stage', 'BUSINESS_STAGE'),
        evidence('financial', 'FINANCIAL_CONDITION'),
      ],
    });
    const validation = validate(catalog([withoutConditionEvidence]));
    expect(validation.ok).toBe(false);
    expect(validation.issues.filter((issue) => issue.code === 'MISSING_EVIDENCE')).toHaveLength(3);
  });
});

describe('automated products in the catalog (ADR 0006)', () => {
  const sourceRef = { source: 'SEMAS_OLS', externalId: 'test-fund' };
  const succeededSync = {
    source: 'SEMAS_OLS',
    status: 'SUCCEEDED',
    attemptedAt: '2026-09-20T01:00:00.000Z',
    lastSucceededOn: REVIEW_DATE,
    fetchedCount: 1,
    responseChecksum: null,
    failureReason: null,
  };
  const automation = (overrides: Record<string, unknown> = {}) => ({
    blockedSources: [],
    sourceSyncs: [succeededSync],
    ...overrides,
  });

  // 출처 최신성은 맞춰 보기가 보류 이유(출처 확인 끊김)로 보여 준다(matching.test.ts). 규칙 검사는 적재를 막거나 주의로 알리지 않는다.
  it('loads a synced product whose source has no recent successful sync', () => {
    const stale = validate(
      catalog([product({ origin: 'SYNC', sourceRef })], { automation: automation({ sourceSyncs: [] }) }),
    );
    expect(stale.ok).toBe(true);
    expect(stale.warnings).toEqual([]);
  });

  it('lets an automated product keep the checksum of a crawled web page, but not a manual product', () => {
    const crawled = (BASE_PRODUCT.evidence as Record<string, unknown>[]).map((entry) => ({
      ...entry,
      checksum: 'a'.repeat(64),
    }));
    const automated = validate(
      catalog([product({ origin: 'SYNC', sourceRef, evidence: crawled })], {
        automation: automation(),
      }),
    );
    expect(issueCodes(automated)).not.toContain('EVIDENCE_CHECKSUM_NOT_APPLICABLE');
    expect(automated.ok).toBe(true);

    const manual = validate(catalog([product({ evidence: crawled })]));
    expect(issueCodes(manual)).toContain('EVIDENCE_CHECKSUM_NOT_APPLICABLE');
  });

  // 출처 식별자가 없으면 출처 최신성과 운영자 숨김(차단 목록)을 적용할 수 없다(ADR 0009 §6).
  it('rejects a synced product without a source reference', () => {
    const validation = validate(catalog([product({ origin: 'SYNC' })]));
    expect(issueCodes(validation)).toContain('SYNCED_PRODUCT_WITHOUT_SOURCE');
  });

  it('rejects two products that point at the same source notice', () => {
    const validation = validate(
      catalog([product({ sourceRef }), product({ productKey: 'test-loan-copy', sourceRef })]),
    );
    expect(issueCodes(validation)).toContain('DUPLICATE_SOURCE_REF');
  });

  it('rejects two sync results for the same source', () => {
    const validation = validate(
      catalog([product()], { automation: automation({ sourceSyncs: [succeededSync, succeededSync] }) }),
    );
    expect(issueCodes(validation)).toContain('DUPLICATE_SOURCE_SYNC');
  });

  it('defaults a catalog without an automation block to no blocked notices and no sync results', () => {
    const parsed = catalogFrom(validate(catalog([product()])));
    expect(parsed.automation).toEqual({ blockedSources: [], sourceSyncs: [] });
  });
});

describe('notices whose business stage or support type is unknown', () => {
  const unknownType = (overrides: Record<string, unknown> = {}) =>
    product({
      supportType: 'UNKNOWN',
      publicLimit: null,
      repaymentMethod: 'UNKNOWN',
      unsupportedCalculationReasons: ['지원 유형이 확인되지 않았습니다.'],
      evidence: [
        evidence('identity', 'IDENTITY'),
        evidence('period', 'APPLICATION_PERIOD'),
        evidence('stage', 'BUSINESS_STAGE'),
        evidence('region', 'REGION'),
        evidence('purpose', 'PURPOSE'),
        evidence('industry', 'INDUSTRY'),
      ],
      ...overrides,
    });

  it('accepts an empty stage list without stage evidence', () => {
    const validation = validate(
      catalog([
        product({
          eligibleBusinessStages: [],
          evidence: [
            evidence('identity', 'IDENTITY'),
            evidence('period', 'APPLICATION_PERIOD'),
            evidence('financial', 'FINANCIAL_CONDITION'),
            evidence('region', 'REGION'),
            evidence('purpose', 'PURPOSE'),
            evidence('industry', 'INDUSTRY'),
          ],
        }),
      ]),
    );
    expect(validation.issues).toEqual([]);
    expect(catalogFrom(validation).products[0].eligibleBusinessStages).toEqual([]);
  });

  it('accepts an unknown support type without financial evidence and never calculates its repayment', () => {
    const validation = validate(catalog([unknownType()]));
    expect(validation.issues).toEqual([]);
    // 유형 미확인 공고는 대출 원금·상환 일정으로 바꾸지 않는다(docs/domains/funding.md 카탈로그).
    expect(repaymentCalculationReasons(catalogFrom(validation).products[0]).join(' ')).toContain('대출 원금');
  });

  it('rejects an unknown support type recorded as not repayable or with confirmed lending terms', () => {
    expect(issueCodes(validate(catalog([unknownType({ repaymentMethod: 'NOT_APPLICABLE' })])))).toContain(
      'SUPPORT_TYPE_FINANCIAL_CONTRADICTION',
    );
    expect(
      issueCodes(
        validate(
          catalog([
            unknownType({ interestRateConfirmed: true, interestCondition: '연 3% 고정', interestRatePercent: '3' }),
          ]),
        ),
      ),
    ).toContain('SUPPORT_TYPE_FINANCIAL_CONTRADICTION');
  });
});

describe('the reviewed 2026-09-20 catalog', () => {
  it('passes every rule check as operator-recorded products', () => {
    const validation = validate(REAL_CATALOG);
    expect(validation.ok).toBe(true);
    expect(validation.checks.some((check) => check.status === 'FAIL')).toBe(false);
    const parsed = catalogFrom(validation);
    expect(parsed.products).toHaveLength(5);
    expect(parsed.basisDate).toBe(REVIEW_DATE);
    // catalog.json에는 사람이 기록한 상품만 있다. 자동 상품은 funding:sync만 만든다(docs/domains/funding.md 동기화).
    expect(parsed.products.every((entry) => entry.origin === 'OPERATOR')).toBe(true);

    const byStatus = parsed.products.map((entry) => entry.observedApplicationStatus);
    expect(byStatus.filter((status) => status === 'CLOSED')).toHaveLength(1);
    expect(byStatus.filter((status) => status === 'UNKNOWN')).toHaveLength(4);
    expect(byStatus.filter((status) => status === 'OPEN')).toHaveLength(0);
  });

  it('keeps all five reviewed products out of repayment calculation', () => {
    const parsed = catalogFrom(validate(REAL_CATALOG));
    expect(parsed.products).toHaveLength(5);
    expect(parsed.products.filter((entry) => entry.supportType === 'LOAN')).toHaveLength(3);
    for (const entry of parsed.products) {
      // 대출 3건은 금리가 확정되지 않았고, 지원금·공간은 대출 원금·상환 일정으로 바꾸지 않는다(catalog README).
      expect(repaymentCalculationReasons(entry).join(' '), entry.productKey).toMatch(
        entry.supportType === 'LOAN' ? /금리/ : /대출 원금/,
      );
    }
  });
});

// 상환 계산 대상인 상품만 funding_product_versions.repaymentCalculationSupported가 true다(아래 DB 테스트).
describe('repayment calculation targets', () => {
  it('calculates only a loan whose limit, rate, term and supported method are all confirmed', () => {
    expect(repaymentCalculationReasons(catalogFrom(validate(catalog([product()]))).products[0]).join(' ')).toContain(
      '금리',
    );

    const bullet = catalogFrom(
      validate(
        catalog([
          product({
            repaymentMethod: 'BULLET',
            interestCondition: '연 3% 고정',
            interestRateConfirmed: true,
            repaymentCondition: '3년 만기일시상환',
          }),
        ]),
      ),
    );
    expect(repaymentCalculationReasons(bullet.products[0]).join(' ')).toContain('지원하지 않습니다');

    const confirmed = catalogFrom(
      validate(
        catalog([
          product({
            repaymentMethod: 'EQUAL_INSTALLMENT',
            interestCondition: '연 3% 고정',
            interestRateConfirmed: true,
            interestRatePercent: '3',
            repaymentCondition: '5년 원리금균등, 거치 없음',
            repaymentTermMonths: 60,
            repaymentGraceMonths: 0,
            unsupportedCalculationReasons: [],
          }),
        ]),
      ),
    );
    expect(repaymentCalculationReasons(confirmed.products[0])).toEqual([]);

    // 구조화된 확정 조건이 없는 상품은 상환 계산 대상이 아니다.
    expect(repaymentCalculationReasons(catalogFrom(validate(catalog([product()]))).products[0]).join(' ')).toContain(
      '상환기간',
    );

    // 거치가 상환기간 이상이면 규칙 검사가 거부하므로 적재되지 않는다.
    expect(issueCodes(validate(catalog([product({ repaymentTermMonths: 12, repaymentGraceMonths: 12 })])))).toContain(
      'REPAYMENT_PERIOD_CONTRADICTION',
    );
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('loading the funding catalog into PostgreSQL', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousActiveId: string | null = null;
  // catalog.json의 catalogVersion. v1.5.0으로 올리며 2026-11-04.1이 됐다(catalog.json notes).
  const REAL_VERSION = '2026-11-04.1';
  const COPIED_CATALOG_PATH = copiedCatalogFile();

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    const staleReleases = await db().fundingCatalogRelease.findMany({
      where: { catalogKey: { startsWith: 'test-' } },
      select: { id: true },
    });
    if (staleReleases.length > 0) {
      const staleIds = staleReleases.map((release) => release.id);
      await db().fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: { in: staleIds } } });
      await db().fundingCatalogRelease.deleteMany({ where: { id: { in: staleIds } } });
    }
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-' } } });
    const baseline = await db().fundingCatalogRelease.findFirst({
      where: { catalogKey: { not: { startsWith: 'test-' } }, status: { in: ['ACTIVE', 'SUPERSEDED'] } },
      orderBy: { activatedAt: 'desc' },
    });
    if (baseline) {
      await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
      await db().fundingCatalogRelease.update({ where: { id: baseline.id }, data: { status: 'ACTIVE' } });
    }
    startedAt = new Date();
    const active = await db().fundingCatalogRelease.findFirst({ where: { status: 'ACTIVE' } });
    previousActiveId = active?.id ?? null;
  });

  afterAll(async () => {
    const releases = await db().fundingCatalogRelease.findMany({ where: { createdAt: { gte: startedAt } } });
    for (const release of releases) await db().fundingCatalogRelease.delete({ where: { id: release.id } });
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-' } } });
    if (previousActiveId) {
      const previous = await db().fundingCatalogRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().fundingCatalogRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  async function activeRelease() {
    return db().fundingCatalogRelease.findFirst({ where: { status: 'ACTIVE' } });
  }

  it('activates the copied catalog and stores immutable product versions', async () => {
    const report = await loadFundingCatalog({
      catalogPath: COPIED_CATALOG_PATH,
      prisma: db(),
      asOfDate: REVIEW_DATE,
      log: () => {},
    });
    expect(report.outcome).toBe('ACTIVATED');
    expect(report.productCount).toBe(5);
    expect(report.catalogChecksum).toHaveLength(64);

    const stored = await db().fundingCatalogRelease.findUnique({ where: { catalogChecksum: report.catalogChecksum } });
    expect(stored?.status).toBe('ACTIVE');
    expect(stored?.catalogVersion).toBe(REAL_VERSION);
    expect(stored?.basisDate.toISOString().slice(0, 10)).toBe(REVIEW_DATE);
    expect(stored?.productCount).toBe(5);

    const versions = await db().fundingProductVersion.findMany({
      where: { productKey: { startsWith: 'test-' } },
      orderBy: { productKey: 'asc' },
    });
    expect(versions).toHaveLength(5);
    for (const version of versions) expect(version.repaymentCalculationSupported).toBe(false);
    const grant = versions.find((version) => version.supportType === 'GRANT');
    expect(grant?.publicLimit).toBeNull();
    expect(grant?.observedApplicationStatus).toBe('CLOSED');
    const loan = versions.find((version) => version.productKey === 'test-seoul-fund-2026-startup-company');
    expect(loan?.publicLimit?.toString()).toBe('100000000');
    expect(loan?.observedApplicationStatus).toBe('UNKNOWN');
    expect(await db().fundingCatalogRelease.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });

  it('reloading the same catalog file is idempotent', async () => {
    const before = await db().fundingProductVersion.count();
    const beforeReleases = await db().fundingCatalogRelease.count();
    const report = await loadFundingCatalog({
      catalogPath: COPIED_CATALOG_PATH,
      prisma: db(),
      asOfDate: REVIEW_DATE,
      log: () => {},
    });
    expect(report.outcome).toBe('ALREADY_ACTIVE');
    expect(await db().fundingProductVersion.count()).toBe(before);
    expect(await db().fundingCatalogRelease.count()).toBe(beforeReleases);
    expect(await db().fundingCatalogRelease.count({ where: { catalogChecksum: report.catalogChecksum } })).toBe(1);
  });

  it('rejects a changed body for an already stored product version', async () => {
    const stored = await activeRelease();
    const changed = JSON.parse(readFileSync(COPIED_CATALOG_PATH, 'utf8')) as {
      catalogVersion: string;
      products: Record<string, unknown>[];
    };
    changed.catalogVersion = '2026-09-20.2';
    changed.products[0] = { ...changed.products[0], name: '이름이 바뀐 상품' };
    const path = writeCatalogFile(changed);

    await expect(
      loadFundingCatalog({ catalogPath: path, prisma: db(), asOfDate: REVIEW_DATE, log: () => {} }),
    ).rejects.toBeInstanceOf(FundingCatalogError);

    const stillActive = await activeRelease();
    expect(stillActive?.id).toBe(stored?.id);
    expect(stillActive?.catalogVersion).toBe(REAL_VERSION);
    expect(await db().fundingProductVersion.findFirst({ where: { name: '이름이 바뀐 상품' } })).toBeNull();
    const failed = await db().fundingCatalogRelease.findFirst({ where: { catalogVersion: '2026-09-20.2' } });
    expect(failed?.status).toBe('FAILED');
    expect(failed?.failureReason).toContain('PRODUCT_VERSION_IMMUTABLE');
  });

  it('a catalog that fails before activation leaves the active catalog untouched', async () => {
    const stored = await activeRelease();
    const productsBefore = await db().fundingProductVersion.count();
    const failing = catalog(
      [
        product({ productKey: 'test-fail-a', version: '0.1.0' }),
        product({ productKey: 'test-fail-b', version: '0.1.0' }),
      ],
      { catalogKey: 'test-failing-catalog', catalogVersion: '2026-09-20.9' },
    );
    const path = writeCatalogFile(failing);

    await expect(
      loadFundingCatalog({
        catalogPath: path,
        prisma: db(),
        asOfDate: REVIEW_DATE,
        log: () => {},
        hooks: {
          beforeActivate: () => {
            throw new Error('의도적으로 활성화 직전에 실패시킵니다.');
          },
        },
      }),
    ).rejects.toThrow('의도적으로 활성화 직전에 실패시킵니다.');

    const stillActive = await activeRelease();
    expect(stillActive?.id).toBe(stored?.id);
    expect(stillActive?.catalogChecksum).toBe(stored?.catalogChecksum);
    expect(await db().fundingProductVersion.count()).toBe(productsBefore);
    expect(await db().fundingProductVersion.count({ where: { productKey: { startsWith: 'test-fail-' } } })).toBe(0);

    const failed = await db().fundingCatalogRelease.findFirst({ where: { catalogKey: 'test-failing-catalog' } });
    expect(failed?.status).toBe('FAILED');
    expect(failed?.failureReason).toContain('의도적으로');
  });

  it('refuses a different body under an already used catalogKey + catalogVersion', async () => {
    const changed = JSON.parse(readFileSync(COPIED_CATALOG_PATH, 'utf8')) as { notes: string[] };
    changed.notes = [...changed.notes, '설명만 바꾼 카탈로그'];
    const path = writeCatalogFile(changed);
    await expect(
      loadFundingCatalog({ catalogPath: path, prisma: db(), asOfDate: REVIEW_DATE, log: () => {} }),
    ).rejects.toThrow(/catalogVersion/);
  });

  it('validates a catalog file before it can be loaded', () => {
    const parsed = readFundingCatalogFile(REAL_CATALOG_PATH, REVIEW_DATE);
    // v1.5.0으로 상품 모양이 바뀌어 1.0.1에서 1.0.2로 올렸다. 1.0.1은 이미 적재된 불변 버전이라 다시 쓸 수 없다(catalog.json notes).
    expect(parsed.catalog.products.map(productVersionKey)).toContain('seoul-fund-2026-inclusive-finance@1.0.2');
  });

  it('links reused immutable product versions to a later catalog release', async () => {
    const firstRelease = await activeRelease();
    const firstMemberships = await db().fundingCatalogProduct.findMany({
      where: { catalogReleaseId: firstRelease?.id },
      orderBy: { position: 'asc' },
    });
    const next = JSON.parse(readFileSync(COPIED_CATALOG_PATH, 'utf8')) as {
      catalogVersion: string;
      notes: string[];
    };
    next.catalogVersion = '2026-09-20.3';
    next.notes = [...next.notes, '상품 버전 재사용 연결 테스트'];
    const nextPath = writeCatalogFile(next);

    const report = await loadFundingCatalog({
      catalogPath: nextPath,
      prisma: db(),
      asOfDate: REVIEW_DATE,
      log: () => {},
    });
    const later = await db().fundingCatalogRelease.findUnique({
      where: { id: report.releaseId },
      include: { products: { orderBy: { position: 'asc' } } },
    });

    expect(later?.products).toHaveLength(5);
    expect(later?.products.map((entry) => entry.productVersionId)).toEqual(
      firstMemberships.map((entry) => entry.productVersionId),
    );
    expect(await db().fundingProductVersion.count({ where: { productKey: { startsWith: 'test-' } } })).toBe(5);
  });

  // 확정 조건이 모두 있는 대출만 상환 계산 대상으로 저장한다(docs/domains/funding.md 카탈로그, catalog README).
  it('stores the repayment calculation flag only for a loan with every term confirmed', async () => {
    const confirmed = product({
      productKey: 'test-repayment-confirmed',
      repaymentMethod: 'EQUAL_INSTALLMENT',
      interestCondition: '연 3% 고정',
      interestRateConfirmed: true,
      interestRatePercent: '3',
      repaymentCondition: '5년 원리금균등, 거치 없음',
      repaymentTermMonths: 60,
      repaymentGraceMonths: 0,
      unsupportedCalculationReasons: [],
    });
    const unconfirmed = product({ productKey: 'test-repayment-unconfirmed' });
    await loadFundingCatalog({
      catalogPath: writeCatalogFile(
        catalog([confirmed, unconfirmed], { catalogKey: 'test-repayment-catalog', catalogVersion: '2026-09-20.7' }),
      ),
      prisma: db(),
      asOfDate: REVIEW_DATE,
      log: () => {},
    });
    const versions = await db().fundingProductVersion.findMany({
      where: { productKey: { startsWith: 'test-repayment-' } },
      select: { productKey: true, repaymentCalculationSupported: true },
    });
    expect(
      Object.fromEntries(versions.map((entry) => [entry.productKey, entry.repaymentCalculationSupported])),
    ).toEqual({
      'test-repayment-confirmed': true,
      'test-repayment-unconfirmed': false,
    });
  });
});
