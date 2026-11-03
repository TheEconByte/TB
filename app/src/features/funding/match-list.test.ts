import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../../lib/checksum.ts';
import { CONDITION_MODEL, CONDITION_PROMPT_VERSION } from './condition-fields.ts';
import { loadFundingCatalog } from './loader.ts';
import { listFundingMatches } from './match-list.ts';
import type { FundingMatchProfile } from './matching.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';

// ADR 0009 4단계 인계: 상품의 지금 본문은 ACTIVE 릴리스 상품 버전의 noticeTextChecksum이다(받은 시각으로 고르지 않는다).
// 조건은 (productKey, 그 checksum, CONDITION_MODEL, CONDITION_PROMPT_VERSION) 한 행에서 읽는다.

const KEY = 'test-match-list-notice';
const AS_OF = '2026-11-03';
const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';
const OLD_TEXT = '1차 공고 본문: 만 39세 이하';
const CURRENT_TEXT = '변경 공고 본문: 만 34세 이하';
const NO_INPUT: FundingMatchProfile = {
  businessStatus: null,
  openedYearMonth: null,
  districtCode: null,
  age: null,
  targetGroups: null,
};

const dirs: string[] = [];
function catalogFile(noticeTextChecksum: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'trendbench-match-list-'));
  dirs.push(dir);
  const path = join(dir, 'catalog.json');
  const evidence = (id: string, subject: string) => ({
    id,
    subject,
    summary: '공식 원문에서 해당 조건을 확인했습니다.',
    sourceUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    observedAt: AS_OF,
    retrievalMethod: 'OFFICIAL_WEB_PAGE',
    checksum: null,
  });
  writeFileSync(
    path,
    JSON.stringify({
      catalogKey: 'test-match-list-catalog',
      schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
      catalogVersion: '2026-11-03.1',
      basisDate: AS_OF,
      reviewer: 'test-reviewer',
      notes: [],
      products: [
        {
          productKey: KEY,
          version: '1.0.0',
          name: '테스트 지원사업',
          organization: '테스트 기관',
          supportType: 'GRANT',
          eligibleBusinessStages: [],
          region: { scope: 'UNKNOWN', districtCodes: [], note: null },
          purpose: { included: [], excluded: [], note: null },
          industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: null },
          applicationPeriod: { start: '2026-10-01', end: '2099-01-01', note: null },
          observedApplicationStatus: 'OPEN',
          observedAt: AS_OF,
          reviewedAt: AS_OF,
          nextReviewAt: '2099-01-01',
          officialUrl: OFFICIAL_URL,
          sourceDocumentName: '테스트 공고문',
          sourceDocumentRetrieved: false,
          sourceChecksum: null,
          publicLimit: null,
          interestCondition: null,
          interestRateConfirmed: false,
          repaymentCondition: null,
          repaymentMethod: 'NOT_APPLICABLE',
          unsupportedCalculationReasons: ['지원금은 상환 계산 대상이 아닙니다.'],
          reviewer: 'test-reviewer',
          evidence: [evidence('identity', 'IDENTITY'), evidence('period', 'APPLICATION_PERIOD')],
          noticeTextChecksum,
        },
      ],
    }),
    'utf8',
  );
  return path;
}

const ageField = (max: number, quote: string) => ({
  age: { status: 'READ', value: { min: null, max, maxExclusive: false }, quote },
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL에서 맞춰 보기의 추출 결과 읽기', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousActiveId: string | null = null;

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  async function cleanUp(): Promise<void> {
    await db().fundingConditionExtraction.deleteMany({ where: { productKey: KEY } });
    await db().fundingNoticeText.deleteMany({ where: { productKey: KEY } });
  }

  async function addText(text: string, retrievedAt: Date): Promise<void> {
    await db().fundingNoticeText.create({
      data: {
        productKey: KEY,
        sourceUrl: OFFICIAL_URL,
        text,
        textChecksum: sha256Hex(text),
        documents: [],
        retrievedAt,
      },
    });
  }

  async function addExtraction(text: string, promptVersion: string, fields: Record<string, unknown>): Promise<void> {
    await db().fundingConditionExtraction.create({
      data: {
        productKey: KEY,
        textChecksum: sha256Hex(text),
        model: CONDITION_MODEL,
        promptVersion,
        fields: fields as never,
        rawOutput: {},
        inputTokens: 1,
        outputTokens: 1,
        extractedAt: new Date('2026-11-03T01:00:00Z'),
      },
    });
  }

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    const stale = await db().fundingCatalogRelease.findMany({
      where: { catalogKey: 'test-match-list-catalog' },
      select: { id: true },
    });
    if (stale.length > 0) {
      await db().fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: { in: stale.map((row) => row.id) } } });
      await db().fundingCatalogRelease.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
    await db().fundingProductVersion.deleteMany({ where: { productKey: KEY } });
    await cleanUp();
    startedAt = new Date();
    previousActiveId = (await db().fundingCatalogRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;

    // 지금 본문(CURRENT_TEXT)보다 옛 본문(OLD_TEXT)을 늦게 받은 것으로 둔다. 받은 시각으로 고르면 틀린다.
    await addText(CURRENT_TEXT, new Date('2026-11-01T00:00:00Z'));
    await addText(OLD_TEXT, new Date('2026-11-02T00:00:00Z'));
    await addExtraction(OLD_TEXT, CONDITION_PROMPT_VERSION, ageField(39, '만 39세 이하'));
    await addExtraction(CURRENT_TEXT, 'funding-conditions-v0', ageField(29, '만 34세 이하'));
    await addExtraction(CURRENT_TEXT, CONDITION_PROMPT_VERSION, ageField(34, '만 34세 이하'));

    const report = await loadFundingCatalog({
      catalogPath: catalogFile(sha256Hex(CURRENT_TEXT)),
      prisma: db(),
      asOfDate: AS_OF,
      log: () => {},
    });
    expect(report.outcome).toBe('ACTIVATED');
  });

  afterAll(async () => {
    const releases = await db().fundingCatalogRelease.findMany({ where: { createdAt: { gte: startedAt } } });
    for (const release of releases) {
      await db().fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: release.id } });
      await db().fundingCatalogRelease.delete({ where: { id: release.id } });
    }
    await db().fundingProductVersion.deleteMany({ where: { productKey: KEY } });
    await cleanUp();
    if (previousActiveId) {
      const previous = await db().fundingCatalogRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().fundingCatalogRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('ACTIVE 상품 버전의 본문 checksum과 지금 모델·프롬프트 버전의 결과만 쓴다', async () => {
    const outcome = await listFundingMatches(db(), { ...NO_INPUT, age: 33 }, { asOfDate: AS_OF });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    const product = outcome.payload.tabs.SUPPORT_PROGRAM.products.find((entry) => entry.productKey === KEY);
    const age = product?.conditions.find((entry) => entry.key === 'age');
    expect(age?.reading).toEqual({
      status: 'READ',
      source: 'AI',
      value: { min: null, max: 34, maxExclusive: false },
      quote: '만 34세 이하',
    });
    expect(age?.verdict).toBe('MATCH');
    // 저장한 결과에 없는 항목은 읽지 못함(확인 필요)이다.
    expect(product?.conditions.find((entry) => entry.key === 'region')?.checkReason).toBe('UNREADABLE');
    expect(outcome.payload.release).toMatchObject({
      catalogKey: 'test-match-list-catalog',
      catalogVersion: '2026-11-03.1',
    });
    expect(outcome.payload.asOfDate).toBe(AS_OF);
  });

  it('ACTIVE 릴리스가 없으면 빈 결과가 아니라 CATALOG_UNAVAILABLE이다', async () => {
    const active = await db().fundingCatalogRelease.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
    try {
      expect(await listFundingMatches(db(), NO_INPUT, { asOfDate: AS_OF })).toEqual({ kind: 'CATALOG_UNAVAILABLE' });
    } finally {
      await db().fundingCatalogRelease.updateMany({
        where: { id: { in: active.map((row) => row.id) } },
        data: { status: 'ACTIVE' },
      });
    }
  });
});
