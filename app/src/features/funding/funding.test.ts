import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { assessProductRepayment, evaluateCandidates, evaluateProduct, industryCodeIssue } from './eligibility.ts';
import { loadFundingCatalog, readFundingCatalogFile } from './loader.ts';
import { productVersionKey, type FundingCatalog } from './schema.ts';
import { combineVerdicts, type Verdict } from './types.ts';
import { FundingCatalogError, validateFundingCatalog, type FundingCatalogValidation } from './validation.ts';

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
  reviewedAt: REVIEW_DATE,
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
  reviewer: 'tester',
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
    schemaVersion: 'funding-catalog-v1.0.0',
    catalogVersion: '2026-09-20.1',
    basisDate: REVIEW_DATE,
    reviewer: 'tester',
    notes: [],
    products,
    ...overrides,
  };
}

function validate(raw: unknown, asOfDate = REVIEW_DATE): FundingCatalogValidation {
  return validateFundingCatalog(raw, { asOfDate });
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

function testCatalogFile(catalogKey: string, productPrefix: string, reviewer: string | null): string {
  const source = JSON.parse(readFileSync(REAL_CATALOG_PATH, 'utf8')) as {
    catalogKey: string;
    catalogVersion: string;
    reviewer: string;
    products: Array<Record<string, unknown> & { productKey: string; reviewer: string }>;
  };
  return writeCatalogFile({
    ...source,
    catalogKey,
    reviewer: reviewer ?? source.reviewer,
    products: source.products.map((entry) => ({
      ...entry,
      productKey: `${productPrefix}${entry.productKey}`,
      reviewer: reviewer ?? entry.reviewer,
    })),
  });
}

function reviewedCatalogFile(): string {
  return testCatalogFile('test-reviewed-catalog', 'test-', 'test-reviewer');
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
    expect(assessProductRepayment(firstProduct(validation))).toMatchObject({
      supported: true,
      publicLimitKrw: '50000000',
      terms: {
        annualInterestRatePercent: '4.5',
        totalMonths: 60,
        graceMonths: 6,
        repaymentMethod: 'EQUAL_PRINCIPAL',
      },
    });
  });

  it('requires official evidence for the identity, period and stage claims', () => {
    const withoutStage = product({
      evidence: [evidence('identity', 'IDENTITY'), evidence('period', 'APPLICATION_PERIOD')],
    });
    const validation = validate(catalog([withoutStage]));
    expect(issueCodes(validation)).toContain('MISSING_EVIDENCE');
  });

  it('records an overdue review instead of treating it as current', () => {
    const overdue = product({ observedAt: '2026-09-10', reviewedAt: '2026-09-10', nextReviewAt: '2026-09-16' });
    const validation = validate(catalog([overdue]));
    expect(validation.ok).toBe(true);
    expect(warningCodes(validation)).toContain('REVIEW_OVERDUE');
    expect(validation.reviewOverdue).toEqual(['test-loan@1.0.0']);

    const onTime = validate(
      catalog([product({ observedAt: '2026-09-10', reviewedAt: '2026-09-10', nextReviewAt: '2026-09-20' })]),
    );
    expect(onTime.reviewOverdue).toEqual([]);
  });

  it('rejects a catalog without review dates', () => {
    const validation = validate(catalog([product({ reviewedAt: null, nextReviewAt: null })]));
    expect(issueCodes(validation)).toContain('REVIEWED_AT_MISSING');
    expect(issueCodes(validation)).toContain('NEXT_REVIEW_AT_MISSING');
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

describe('the reviewed 2026-09-20 catalog', () => {
  it('passes every rule check and reports the review state of each product', () => {
    const validation = validate(REAL_CATALOG);
    expect(validation.ok).toBe(true);
    expect(validation.checks.some((check) => check.status === 'FAIL')).toBe(false);
    const parsed = catalogFrom(validation);
    expect(parsed.products).toHaveLength(5);
    expect(parsed.basisDate).toBe(REVIEW_DATE);
    expect(validation.reviewOverdue).toEqual(['gangbuk-startup-center-2026-h2-residency@1.0.0']);

    const byStatus = parsed.products.map((entry) => entry.observedApplicationStatus);
    expect(byStatus.filter((status) => status === 'CLOSED')).toHaveLength(1);
    expect(byStatus.filter((status) => status === 'UNKNOWN')).toHaveLength(4);
    expect(byStatus.filter((status) => status === 'OPEN')).toHaveLength(0);
  });

  it('separates pre-registration, post-registration, closed and overdue products', () => {
    const parsed = catalogFrom(validate(REAL_CATALOG));
    const pre = evaluateCandidates(
      parsed,
      { businessStage: 'PRE_REGISTRATION', districtCode: '11200', industryCode: 'CS100010', purpose: 'STARTUP_COST' },
      { asOfDate: REVIEW_DATE },
    );
    expect(pre.summary.CURRENT_CANDIDATE).toBe(0);
    expect(pre.summary.NEEDS_CONFIRMATION).toBe(3);
    expect(pre.summary.POST_REGISTRATION).toBe(0);
    expect(pre.summary.CLOSED).toBe(1);
    expect(pre.summary.REVIEW_OVERDUE).toBe(1);

    const post = evaluateCandidates(
      parsed,
      {
        businessStage: 'POST_REGISTRATION',
        districtCode: '11200',
        industryCode: 'CS100010',
        purpose: 'OPERATING_FUNDS',
      },
      { asOfDate: REVIEW_DATE },
    );
    expect(post.summary.POST_REGISTRATION).toBe(0);
    expect(post.summary.CURRENT_CANDIDATE).toBe(0);
  });

  it('never exposes a grant or space product as a loan repayment target', () => {
    const parsed = catalogFrom(validate(REAL_CATALOG));
    const nonLoans = parsed.products.filter((entry) => entry.supportType !== 'LOAN');
    expect(nonLoans.length).toBeGreaterThan(0);
    for (const entry of nonLoans) {
      const repayment = assessProductRepayment(entry);
      expect(repayment.supported).toBe(false);
      expect(repayment.publicLimitKrw).toBeNull();
      expect(repayment.reasons.join(' ')).toMatch(/대출 원금|상환 일정/);
    }
  });

  it('accepts the catalog for loading while reviewers are unassigned', () => {
    expect(validate(REAL_CATALOG).ok).toBe(true);
    expect(readFundingCatalogFile(REAL_CATALOG_PATH, REVIEW_DATE).catalog.reviewer).toBe('UNASSIGNED');
  });

  it('keeps every loan uncalculated while the rate and repayment method are unknown', () => {
    const parsed = catalogFrom(validate(REAL_CATALOG));
    const loans = parsed.products.filter((entry) => entry.supportType === 'LOAN');
    expect(loans).toHaveLength(3);
    for (const loan of loans) {
      const repayment = assessProductRepayment(loan);
      expect(repayment.supported).toBe(false);
      expect(repayment.publicLimitKrw).toBeNull();
      expect(repayment.reasons.join(' ')).toMatch(/금리/);
    }
  });

  it('never exposes any of the five reviewed products as a repayment assumption', () => {
    const parsed = catalogFrom(validate(REAL_CATALOG));
    expect(parsed.products).toHaveLength(5);
    for (const entry of parsed.products) {
      const repayment = assessProductRepayment(entry);
      expect(repayment.supported).toBe(false);
      expect(repayment.publicLimitKrw).toBeNull();
      expect(repayment.terms).toBeNull();
      expect(repayment.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('condition verdicts and candidate status', () => {
  const preProfile = {
    businessStage: 'PRE_REGISTRATION',
    districtCode: '11200',
    industryCode: 'CS100010',
    purpose: 'OPERATING_FUNDS',
  } as const;

  it('combines FAIL and UNKNOWN into FAIL and UNKNOWN alone into UNKNOWN', () => {
    expect(combineVerdicts(['PASS', 'UNKNOWN', 'FAIL'])).toBe('FAIL');
    expect(combineVerdicts(['PASS', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(combineVerdicts(['PASS', 'PASS'])).toBe('PASS');
    expect(combineVerdicts([])).toBe('UNKNOWN');
  });

  it('flags an industry code that the stored profile schema would reject', () => {
    expect(industryCodeIssue('')).toBeNull();
    expect(industryCodeIssue(' cs100010 ')).toBeNull();
    expect(industryCodeIssue('CS10001')).not.toBeNull();
    expect(industryCodeIssue('CS1000100')).not.toBeNull();
    expect(industryCodeIssue('A1000010')).not.toBeNull();
  });

  it('returns FAIL when one condition fails and another is unknown', () => {
    const failing = product({
      region: { scope: 'DISTRICTS', districtCodes: ['11110'], note: null },
      industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: '업종 매핑 미검수' },
    });
    const parsed = catalogFrom(validate(catalog([failing])));
    const evaluation = evaluateProduct(parsed.products[0], preProfile, { asOfDate: REVIEW_DATE });
    const verdicts = new Map(evaluation.conditions.map((condition) => [condition.key, condition.verdict]));
    expect(verdicts.get('REGION')).toBe('FAIL');
    expect(verdicts.get('INDUSTRY')).toBe('UNKNOWN');
    expect(evaluation.eligibilityVerdict).toBe<Verdict>('FAIL');
    expect(evaluation.candidateStatus).toBe('NOT_ELIGIBLE');
  });

  it('returns UNKNOWN when no condition fails but one is unknown', () => {
    const unknownScope = product({
      industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: '업종 매핑 미검수' },
    });
    const parsed = catalogFrom(validate(catalog([unknownScope])));
    const evaluation = evaluateProduct(parsed.products[0], preProfile, { asOfDate: REVIEW_DATE });
    expect(evaluation.eligibilityVerdict).toBe<Verdict>('UNKNOWN');
    expect(evaluation.candidateStatus).toBe('NEEDS_CONFIRMATION');
  });

  it('keeps a post-registration product out of the pre-registration candidate group', () => {
    const postOnly = product({ eligibleBusinessStages: ['POST_REGISTRATION'] });
    const parsed = catalogFrom(validate(catalog([postOnly])));
    const pre = evaluateProduct(parsed.products[0], preProfile, { asOfDate: REVIEW_DATE });
    expect(pre.audience).toBe('POST_REGISTRATION_ONLY');
    expect(pre.candidateStatus).toBe('POST_REGISTRATION');

    const post = evaluateProduct(
      parsed.products[0],
      { ...preProfile, businessStage: 'POST_REGISTRATION' },
      { asOfDate: REVIEW_DATE },
    );
    expect(post.candidateStatus).not.toBe('POST_REGISTRATION');
  });

  it('excludes a product whose review deadline passed even when it is open', () => {
    const overdue = product({ observedAt: '2026-09-10', reviewedAt: '2026-09-10', nextReviewAt: '2026-09-16' });
    const parsed = catalogFrom(validate(catalog([overdue])));
    const evaluation = evaluateProduct(parsed.products[0], preProfile, { asOfDate: REVIEW_DATE });
    expect(evaluation.observedApplicationStatus).toBe('OPEN');
    expect(evaluation.reviewState).toBe('REVIEW_OVERDUE');
    expect(evaluation.candidateStatus).toBe('REVIEW_OVERDUE');
  });

  it('never exposes an unassigned reviewed product as a current candidate', () => {
    const unassigned = product({ reviewer: 'UNASSIGNED' });
    const parsed = catalogFrom(validate(catalog([unassigned])));
    const evaluation = evaluateProduct(parsed.products[0], preProfile, { asOfDate: REVIEW_DATE });
    expect(evaluation.reviewState).toBe('UNREVIEWED');
    expect(evaluation.candidateStatus).toBe('NEEDS_CONFIRMATION');
    expect(evaluation.candidateReason).toContain('검수자가 지정되지 않아');
  });

  it('never turns a closed notice into a current candidate', () => {
    const parsed = catalogFrom(
      validate(
        catalog([
          product({
            observedApplicationStatus: 'CLOSED',
            applicationPeriod: { start: '2026-03-01', end: '2026-03-26', note: null },
          }),
        ]),
      ),
    );
    const evaluation = evaluateProduct(parsed.products[0], preProfile, { asOfDate: REVIEW_DATE });
    expect(evaluation.candidateStatus).toBe('CLOSED');
  });

  it('does not confirm a candidate that is backed only by search-result summaries', () => {
    const parsed = catalogFrom(
      validate(
        catalog([
          product({
            evidence: [
              evidence('identity', 'IDENTITY', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
              evidence('period', 'APPLICATION_PERIOD', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
              evidence('stage', 'BUSINESS_STAGE', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
              evidence('financial', 'FINANCIAL_CONDITION', { retrievalMethod: 'SEARCH_RESULT_SUMMARY' }),
            ],
          }),
        ]),
      ),
    );
    const evaluation = evaluateProduct(parsed.products[0], preProfile, { asOfDate: REVIEW_DATE });
    expect(evaluation.eligibilityVerdict).toBe<Verdict>('UNKNOWN');
    expect(evaluation.primaryEvidenceVerified).toBe(false);
    expect(evaluation.candidateStatus).toBe('NEEDS_CONFIRMATION');
    expect(evaluation.candidateReason).toContain('원문');
  });

  it('never marks repayment as available when the rate or method is unresolved', () => {
    const unknownRate = catalogFrom(validate(catalog([product()]))).products[0];
    expect(assessProductRepayment(unknownRate)).toMatchObject({ supported: false, publicLimitKrw: null });

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
    const bulletRepayment = assessProductRepayment(bullet.products[0]);
    expect(bulletRepayment.supported).toBe(false);
    expect(bulletRepayment.publicLimitKrw).toBeNull();
    expect(bulletRepayment.reasons.join(' ')).toContain('지원하지 않습니다');

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
    expect(assessProductRepayment(confirmed.products[0])).toMatchObject({
      supported: true,
      publicLimitKrw: '50000000',
      terms: {
        annualInterestRatePercent: '3',
        totalMonths: 60,
        graceMonths: 0,
        repaymentMethod: 'EQUAL_INSTALLMENT',
      },
    });

    // 구조화된 확정 조건이 없는 상품은 기존과 같이 상환 계산 대상이 아니다.
    const withoutTerms = catalogFrom(validate(catalog([product()])));
    const withoutTermsRepayment = assessProductRepayment(withoutTerms.products[0]);
    expect(withoutTermsRepayment.supported).toBe(false);
    expect(withoutTermsRepayment.terms).toBeNull();
    expect(withoutTermsRepayment.reasons.join(' ')).toContain('상환기간');

    const graceOverTerm = catalogFrom(
      validate(
        catalog([
          product({
            repaymentMethod: 'EQUAL_PRINCIPAL',
            interestCondition: '연 3% 고정',
            interestRateConfirmed: true,
            interestRatePercent: '3',
            repaymentCondition: '12개월 상환, 12개월 거치',
            repaymentTermMonths: 12,
            repaymentGraceMonths: 12,
            unsupportedCalculationReasons: [],
          }),
        ]),
      ),
    );
    expect(issueCodes(validate(catalog([product({ repaymentTermMonths: 12, repaymentGraceMonths: 12 })])))).toContain(
      'REPAYMENT_PERIOD_CONTRADICTION',
    );
    const graceRepayment = assessProductRepayment(graceOverTerm.products[0]);
    expect(graceRepayment.supported).toBe(false);
    expect(graceRepayment.terms).toBeNull();
    expect(graceRepayment.reasons.join(' ')).toContain('거치개월이 전체 상환개월보다');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('loading the funding catalog into PostgreSQL', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousActiveId: string | null = null;
  const REAL_VERSION = '2026-09-20.1';
  const REVIEWED_CATALOG_PATH = reviewedCatalogFile();

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

  it('activates the reviewed catalog and stores immutable product versions', async () => {
    const report = await loadFundingCatalog({
      catalogPath: REVIEWED_CATALOG_PATH,
      prisma: db(),
      asOfDate: REVIEW_DATE,
      log: () => {},
    });
    expect(report.outcome).toBe('ACTIVATED');
    expect(report.productCount).toBe(5);
    expect(report.reviewOverdue).toEqual(['test-gangbuk-startup-center-2026-h2-residency@1.0.0']);
    expect(report.catalogChecksum).toHaveLength(64);

    const stored = await db().fundingCatalogRelease.findUnique({ where: { catalogChecksum: report.catalogChecksum } });
    expect(stored?.status).toBe('ACTIVE');
    expect(stored?.catalogVersion).toBe(REAL_VERSION);
    expect(stored?.basisDate.toISOString().slice(0, 10)).toBe(REVIEW_DATE);
    expect(stored?.reviewedAt?.toISOString().slice(0, 10)).toBe(REVIEW_DATE);
    expect(stored?.productCount).toBe(5);
    expect(stored?.reviewer).toBe('test-reviewer');

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
    expect(loan?.nextReviewAt?.toISOString().slice(0, 10)).toBe('2026-10-20');
    expect(await db().fundingCatalogRelease.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });

  it('reloading the same catalog file is idempotent', async () => {
    const before = await db().fundingProductVersion.count();
    const beforeReleases = await db().fundingCatalogRelease.count();
    const report = await loadFundingCatalog({
      catalogPath: REVIEWED_CATALOG_PATH,
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
    const changed = JSON.parse(readFileSync(REVIEWED_CATALOG_PATH, 'utf8')) as {
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
    const changed = JSON.parse(readFileSync(REVIEWED_CATALOG_PATH, 'utf8')) as { notes: string[] };
    changed.notes = [...changed.notes, '설명만 바꾼 카탈로그'];
    const path = writeCatalogFile(changed);
    await expect(
      loadFundingCatalog({ catalogPath: path, prisma: db(), asOfDate: REVIEW_DATE, log: () => {} }),
    ).rejects.toThrow(/catalogVersion/);
  });

  it('validates a catalog file before it can be loaded', () => {
    const parsed = readFundingCatalogFile(REAL_CATALOG_PATH, REVIEW_DATE);
    expect(parsed.reviewOverdue).toEqual(['gangbuk-startup-center-2026-h2-residency@1.0.0']);
    expect(parsed.catalog.products.map(productVersionKey)).toContain('seoul-fund-2026-inclusive-finance@1.0.0');
  });

  it('links reused immutable product versions to a later catalog release', async () => {
    const firstRelease = await activeRelease();
    const firstMemberships = await db().fundingCatalogProduct.findMany({
      where: { catalogReleaseId: firstRelease?.id },
      orderBy: { position: 'asc' },
    });
    const next = JSON.parse(readFileSync(REVIEWED_CATALOG_PATH, 'utf8')) as {
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

  it('activates a catalog whose reviewers are still UNASSIGNED', async () => {
    const report = await loadFundingCatalog({
      catalogPath: testCatalogFile('test-unassigned-catalog', 'test-unassigned-', null),
      prisma: db(),
      asOfDate: REVIEW_DATE,
      log: () => {},
    });
    expect(report.outcome).toBe('ACTIVATED');
    const stored = await db().fundingCatalogRelease.findUnique({ where: { id: report.releaseId } });
    expect(stored?.status).toBe('ACTIVE');
    expect(stored?.reviewer).toBe('UNASSIGNED');
  });
});
