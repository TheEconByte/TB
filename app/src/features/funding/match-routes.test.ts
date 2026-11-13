import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../../lib/checksum.ts';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));

import { POST as postCandidates } from '@/app/api/funding/candidates/route';
import { CONDITION_MODEL, CONDITION_PROMPT_VERSION } from './condition-fields.ts';
import { todayInKst } from './dates.ts';
import type { FundingMatchesWithProfile } from './match-list.ts';
import type { FundingMatchProfile } from './matching.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';

// /api/funding/candidates는 ADR 0009 §4의 맞춰 보기를 돌려준다(5c). 인증·요청 검사·오류 구분은 기존 경계를 잇는다:
// 미로그인 401, 잘못된 입력 400, 활성 릴리스 없음 503. 기준일은 서버의 한국 시간 오늘이며 본문으로 바꿀 수 없다.

const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';
const NOTICE_CHECKSUM = sha256Hex('테스트 공고 본문');
const FAR_FUTURE = '2099-01-01';

const evidence = (id: string, subject: string) => ({
  id,
  subject,
  summary: '공식 원문에서 해당 조건을 확인했습니다.',
  sourceUrl: OFFICIAL_URL,
  sourceDocumentName: '테스트 공고문',
  observedAt: '2026-11-01',
  retrievalMethod: 'OFFICIAL_WEB_PAGE',
  checksum: null,
});

// 사람이 등록한 지원금. 사업 단계·지역은 공식 원문 근거가 있어 운영자 확인 값으로 쓴다(ADR §3).
const PRODUCT = {
  productKey: 'test-grant',
  version: '1.0.0',
  name: '테스트 지원금',
  organization: '테스트 기관',
  supportType: 'GRANT',
  eligibleBusinessStages: ['PRE_REGISTRATION'],
  region: { scope: 'SEOUL', districtCodes: [], note: null },
  purpose: { included: [], excluded: [], note: null },
  industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: null },
  applicationPeriod: { start: '2026-01-01', end: FAR_FUTURE, note: null },
  observedApplicationStatus: 'OPEN',
  observedAt: '2026-11-01',
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
  additionalChecks: [],
  origin: 'OPERATOR',
  evidence: [
    evidence('identity', 'IDENTITY'),
    evidence('period', 'APPLICATION_PERIOD'),
    evidence('stage', 'BUSINESS_STAGE'),
    evidence('region', 'REGION'),
  ],
  noticeTextChecksum: NOTICE_CHECKSUM,
};

// 본문에서 AI가 읽은 나머지 네 항목. 나이는 만 39세 이하다.
const FIELDS = {
  businessAge: { status: 'READ', value: { min: null, max: null, maxExclusive: false }, quote: '업력 제한 없음' },
  age: { status: 'READ', value: { min: null, max: 39, maxExclusive: false }, quote: '만 39세 이하' },
  foodBusiness: { status: 'READ', value: 'NOT_EXCLUDED', quote: '업종 제한 없음' },
  targetGroups: { status: 'READ', value: { groups: [], note: null }, quote: '누구나 신청' },
};

function stubPrisma(active: boolean) {
  const findRelease = vi.fn().mockResolvedValue(
    active
      ? {
          id: 'release-1',
          catalogKey: 'test-catalog',
          catalogVersion: '2026-11-03.1',
          schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
          basisDate: new Date('2026-11-03T00:00:00.000Z'),
          activatedAt: new Date('2026-11-03T03:00:00.000Z'),
          automation: null,
          products: [{ position: 0, productVersion: { productJson: PRODUCT } }],
        }
      : null,
  );
  const findExtractions = vi
    .fn()
    .mockResolvedValue([{ productKey: 'test-grant', textChecksum: NOTICE_CHECKSUM, fields: FIELDS }]);
  const prisma = {
    fundingCatalogRelease: { findFirst: findRelease },
    fundingConditionExtraction: { findMany: findExtractions },
  } as unknown as PrismaClient;
  return { prisma, findRelease, findExtractions };
}

const VALID: FundingMatchProfile = {
  businessStatus: 'PRE_STARTUP',
  openedYearMonth: null,
  districtCode: '11440',
  age: 35,
  targetGroups: [],
};

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/funding/candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: 'user-a', email: 'a@example.com' });
});

describe('POST /api/funding/candidates 경계', () => {
  it('미로그인 요청을 401로 차단하고 카탈로그를 조회하지 않는다', async () => {
    mocks.currentUser.mockResolvedValue(null);
    const response = await postCandidates(jsonRequest(VALID));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('잘못된 입력과 없앤 업종·용도 입력을 400으로 거부한다', async () => {
    const invalidBodies: unknown[] = [
      {},
      // 5c 전의 요청 모양. 업종·용도는 더 받지 않는다(ADR 0009 §4).
      {
        businessStage: 'PRE_REGISTRATION',
        districtCode: '11440',
        industryCode: 'CS100010',
        purpose: 'OPERATING_FUNDS',
      },
      { ...VALID, industryCode: 'CS100010' },
      { ...VALID, businessStatus: 'BUSINESS', openedYearMonth: '2024-13' },
      { ...VALID, age: 34.5 },
      { ...VALID, districtCode: '41135' },
      { ...VALID, targetGroups: ['DAMAGED'] },
    ];
    for (const body of invalidBodies) {
      const response = await postCandidates(jsonRequest(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
    }
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('본문으로 판정 기준일(asOfDate)을 지정할 수 없다', async () => {
    const response = await postCandidates(jsonRequest({ ...VALID, asOfDate: '2000-01-01' }));
    expect(response.status).toBe(400);
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('활성 카탈로그 릴리스가 없으면 빈 결과가 아니라 503 CATALOG_UNAVAILABLE이다', async () => {
    mocks.getPrisma.mockReturnValue(stubPrisma(false).prisma);
    const response = await postCandidates(jsonRequest(VALID));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('CATALOG_UNAVAILABLE');
  });

  it('저장된 추출 결과와 입력을 맞춰 갈래·그룹별로 돌려준다', async () => {
    const stub = stubPrisma(true);
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const dayBefore = todayInKst();
    const response = await postCandidates(jsonRequest(VALID));
    const dayAfter = todayInKst();
    expect(response.status).toBe(200);
    const body = (await response.json()) as FundingMatchesWithProfile;
    // 요청 중 한국 시간 자정을 넘길 수 있으므로 요청 전후 날짜 중 하나와 같으면 된다.
    expect([dayBefore, dayAfter]).toContain(body.asOfDate);
    expect(body.profile).toEqual(VALID);
    expect(body.release).toMatchObject({ catalogKey: 'test-catalog', catalogVersion: '2026-11-03.1', productCount: 1 });
    // 지금 모델·프롬프트 버전의 결과만 읽는다(match-list.ts). 웹 요청은 AI를 부르지 않는다.
    expect(stub.findExtractions.mock.calls[0][0].where).toMatchObject({
      model: CONDITION_MODEL,
      promptVersion: CONDITION_PROMPT_VERSION,
    });
    // 지원금은 지원사업 갈래다(ADR §1, 사람이 등록한 상품은 지원 유형으로 정한다).
    expect(body.tabs.POLICY_FUND.products).toHaveLength(0);
    const [match] = body.tabs.SUPPORT_PROGRAM.products;
    expect(match.group).toBe('MATCHING');
    expect(match.conditions.map((entry) => entry.verdict)).toEqual([
      'MATCH',
      'MATCH',
      'MATCH',
      'MATCH',
      'MATCH',
      'MATCH',
    ]);
    expect(match.conditions.find((entry) => entry.key === 'age')?.reading).toMatchObject({ quote: '만 39세 이하' });
  });

  it('AI가 읽은 조건이 안 맞아도 공고를 빼지 않고 안 맞아 보임으로 돌려준다', async () => {
    // 사용자 결정(2026-11-13): 화면은 안 맞는 공고를 목록에서 빼지만 다시 펼쳐 볼 수 있어야 하므로, 응답에서는 지우지 않는다.
    mocks.getPrisma.mockReturnValue(stubPrisma(true).prisma);
    const body = (await (await postCandidates(jsonRequest({ ...VALID, age: 45 }))).json()) as FundingMatchesWithProfile;
    expect(body.tabs.SUPPORT_PROGRAM.products.map((entry) => entry.group)).toEqual(['NOT_MATCHING']);
    expect(body.tabs.SUPPORT_PROGRAM.counts.NOT_MATCHING).toBe(1);
    expect(body.hiddenCount).toBe(0);
  });
});
