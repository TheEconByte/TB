import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateProduct } from '../eligibility.ts';
import type { FundingSourceCollection } from '../sync.ts';
import { AUTO_REVIEWER, FUNDING_CATALOG_SCHEMA_VERSION } from '../types.ts';
import { validateFundingCatalog } from '../validation.ts';
import {
  BIZINFO_API_URL,
  BIZINFO_SEARCH_COUNT,
  bizinfoRegion,
  createBizinfoAdapter,
  mapBizinfoItems,
  parseBizinfoPeriod,
} from './bizinfo.ts';

const AS_OF = '2026-09-28';
const API_KEY = 'test-bizinfo-key-0123456789';
const CHECKSUM = 'c'.repeat(64);

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pblancId: 'PBLN_000000000112345',
    pblancNm: '[서울] 2026년 소상공인 디지털 전환 지원사업 공고',
    pblancUrl: '/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000112345',
    jrsdInsttNm: '서울특별시',
    excInsttNm: '서울신용보증재단',
    reqstBeginEndDe: '2026-09-01 ~ 2026-10-31',
    trgetNm: '소상공인',
    pldirSportRealmLclasCodeNm: '경영',
    totCnt: 1,
    ...overrides,
  };
}

type Call = { url: string };

function fakeFetch(responses: Array<{ status: number; body: string } | Error>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string) => {
    calls.push({ url });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => next.body };
  };
  return { calls, fetchImpl };
}

function collect(
  responses: Array<{ status: number; body: string } | Error>,
  apiKey: string | undefined = API_KEY,
): { promise: Promise<FundingSourceCollection>; calls: Call[]; logs: string[] } {
  const { calls, fetchImpl } = fakeFetch(responses);
  const logs: string[] = [];
  const adapter = createBizinfoAdapter({ apiKey, fetchImpl, retryDelayMs: 0 });
  return { promise: adapter.collect({ asOfDate: AS_OF, log: (message) => logs.push(message) }), calls, logs };
}

function body(items: unknown[]): string {
  return JSON.stringify({ jsonArray: items });
}

function catalogWith(products: unknown[], sourceSyncs: unknown[] = []) {
  return {
    catalogKey: 'test-bizinfo-catalog',
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    catalogVersion: `${AS_OF}.1`,
    basisDate: AS_OF,
    reviewer: 'tester',
    notes: [],
    automation: { policyLoanPromotion: true, repaymentPromotion: true, blockedSources: [], sourceSyncs },
    products,
  };
}

describe('기업마당 신청기간·지역 해석', () => {
  it('날짜 두 개로 적힌 신청기간만 날짜로 읽는다', () => {
    expect(parseBizinfoPeriod('2026-09-01 ~ 2026-10-31')).toEqual({ start: '2026-09-01', end: '2026-10-31' });
    expect(parseBizinfoPeriod(' 2026-09-01~2026-09-01 ')).toEqual({ start: '2026-09-01', end: '2026-09-01' });
    expect(parseBizinfoPeriod('예산 소진시까지')).toBeNull();
    expect(parseBizinfoPeriod('상시 접수')).toBeNull();
    expect(parseBizinfoPeriod('2026-02-30 ~ 2026-03-10')).toBeNull();
    expect(parseBizinfoPeriod('2026-10-31 ~ 2026-09-01')).toBeNull();
  });

  it('공고명 [지역] 표시와 소관기관으로 서울·자치구·다른 시·도를 가린다', () => {
    expect(bizinfoRegion('[서울] 소상공인 지원', '중소벤처기업부')).toMatchObject({ scope: 'SEOUL' });
    expect(bizinfoRegion('[서울] 소상공인 지원', '서울특별시 중구')).toMatchObject({
      scope: 'DISTRICTS',
      districtCodes: ['11140'],
    });
    expect(bizinfoRegion('소상공인 지원', '서울특별시 동대문구')).toMatchObject({
      scope: 'DISTRICTS',
      districtCodes: ['11230'],
    });
    expect(bizinfoRegion('소상공인 지원', '서울경제진흥원')).toMatchObject({ scope: 'SEOUL' });
    expect(bizinfoRegion('[경기] 소상공인 지원', '경기도')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('[충북 청주] 소상공인 지원', '중소벤처기업부')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('소상공인 지원', '부산광역시 해운대구')).toEqual({ scope: 'OTHER' });
    // 서울 밖 같은 이름의 구는 자치구로 잡지 않는다.
    expect(bizinfoRegion('소상공인 지원', '대구광역시 중구')).toEqual({ scope: 'OTHER' });
    // 지역 신호가 없으면 전국으로 추측하지 않는다.
    expect(bizinfoRegion('소상공인 정책자금 공고', '중소벤처기업부')).toEqual({ scope: 'UNKNOWN' });
    expect(bizinfoRegion('[전국] 소상공인 정책자금 공고', '중소벤처기업부')).toEqual({ scope: 'UNKNOWN' });
  });
});

describe('기업마당 공고를 카탈로그 상품으로 바꾸기', () => {
  it('사업 단계·지원 유형을 추측하지 않고, 검증을 통과하는 추가 확인 상품을 만든다', () => {
    const { products, skipped } = mapBizinfoItems([item()], { asOfDate: AS_OF, responseChecksum: CHECKSUM });
    expect(skipped).toEqual({ notTarget: 0, otherRegion: 0, ended: 0, malformed: 0, duplicate: 0 });
    expect(products).toHaveLength(1);
    const [product] = products;
    expect(product).toMatchObject({
      productKey: 'bizinfo-pbln-000000000112345',
      name: '[서울] 2026년 소상공인 디지털 전환 지원사업 공고',
      organization: '서울특별시 · 서울신용보증재단',
      supportType: 'UNKNOWN',
      eligibleBusinessStages: [],
      region: { scope: 'SEOUL', districtCodes: [], note: null },
      purpose: { included: [], excluded: [] },
      industryConditions: { scope: 'UNKNOWN', included: [], excluded: [] },
      applicationPeriod: { start: '2026-09-01', end: '2026-10-31', note: null },
      observedApplicationStatus: 'OPEN',
      observedAt: AS_OF,
      reviewedAt: AS_OF,
      nextReviewAt: null,
      officialUrl: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000112345',
      repaymentMethod: 'UNKNOWN',
      publicLimit: null,
      interestRateConfirmed: false,
      sourceRef: { source: 'BIZINFO', externalId: 'PBLN_000000000112345' },
    });
    expect(product.additionalChecks).toContain('기업마당 지원대상 표시: 소상공인');
    expect(product.evidence.map((entry) => [entry.subject, entry.retrievalMethod, entry.checksum])).toEqual([
      ['IDENTITY', 'OFFICIAL_API', CHECKSUM],
      ['APPLICATION_PERIOD', 'OFFICIAL_API', CHECKSUM],
      ['REGION', 'OFFICIAL_API', CHECKSUM],
    ]);

    const version = { ...product, version: '1.0.0', reviewer: AUTO_REVIEWER };
    const validation = validateFundingCatalog(catalogWith([version]), { asOfDate: AS_OF });
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('두 스위치가 켜지고 출처가 최신이어도 기업마당 상품은 현재 후보가 되지 않는다', () => {
    const { products } = mapBizinfoItems([item()], { asOfDate: AS_OF, responseChecksum: CHECKSUM });
    const freshSync = {
      source: 'BIZINFO',
      status: 'SUCCEEDED',
      attemptedAt: `${AS_OF}T01:00:00.000Z`,
      lastSucceededOn: AS_OF,
      fetchedCount: 1,
      responseChecksum: CHECKSUM,
      failureReason: null,
    };
    const validation = validateFundingCatalog(
      catalogWith([{ ...products[0], version: '1.0.0', reviewer: AUTO_REVIEWER }], [freshSync]),
      { asOfDate: AS_OF },
    );
    const catalog = validation.catalog;
    if (catalog === null) throw new Error('카탈로그 검증에 실패했습니다.');
    const evaluation = evaluateProduct(
      catalog.products[0],
      { businessStage: 'PRE_REGISTRATION', districtCode: '11140', industryCode: 'CS100010', purpose: 'STARTUP_COST' },
      { asOfDate: AS_OF, automation: catalog.automation },
    );
    expect(evaluation.reviewState).toBe('CURRENT');
    expect(evaluation.audience).toBe('UNKNOWN');
    expect(evaluation.primaryEvidenceVerified).toBe(true);
    expect(evaluation.candidateStatus).toBe('NEEDS_CONFIRMATION');
    expect(evaluation.candidateReason).toContain('사업 단계를 확인하지 못했습니다');
    expect(evaluation.repayment.supported).toBe(false);
    expect(evaluation.repayment.note).toContain('지원 유형이 확인되지 않은');
  });

  it('소상공인·창업벤처 대상이 아닌 공고, 서울 밖 공고, 끝난 공고, 형식이 깨진 공고와 중복은 빼고 센다', () => {
    const { products, skipped } = mapBizinfoItems(
      [
        item({ pblancId: 'PBLN_A', trgetNm: '중소기업' }),
        item({ pblancId: 'PBLN_B', pblancNm: '[경기] 소상공인 경영 개선 지원', jrsdInsttNm: '경기도' }),
        item({ pblancId: 'PBLN_C', pblancNm: '소상공인 지원', jrsdInsttNm: '부산광역시' }),
        item({ pblancId: 'PBLN_D', reqstBeginEndDe: '2026-08-01 ~ 2026-09-27' }),
        item({ pblancId: '' }),
        item({ pblancId: 'PBLN_E', pblancUrl: 'https://blog.example.com/notice' }),
        'not an object',
        item({ pblancId: 'PBLN_F', trgetNm: '중소기업,창업벤처', jrsdInsttNm: '서울특별시 중구', excInsttNm: '' }),
        item({ pblancId: 'PBLN_F' }),
        item({
          pblancId: 'PBLN_G',
          pblancNm: '소상공인 정책자금 변경 공고',
          jrsdInsttNm: '중소벤처기업부',
          excInsttNm: '소상공인시장진흥공단',
          reqstBeginEndDe: '예산 소진시까지',
          pldirSportRealmLclasCodeNm: '금융',
        }),
        item({ pblancId: 'PBLN_H', reqstBeginEndDe: '2026-10-01 ~ 2026-10-31' }),
      ],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    );
    expect(skipped).toEqual({ notTarget: 1, otherRegion: 2, ended: 1, malformed: 3, duplicate: 1 });
    const byId = new Map(products.map((product) => [product.sourceRef.externalId, product]));
    expect([...byId.keys()]).toEqual(['PBLN_F', 'PBLN_G', 'PBLN_H']);

    expect(byId.get('PBLN_F')).toMatchObject({
      organization: '서울특별시 중구',
      region: { scope: 'DISTRICTS', districtCodes: ['11140'], note: null },
    });
    const nationwide = byId.get('PBLN_G');
    expect(nationwide?.region).toMatchObject({ scope: 'UNKNOWN', districtCodes: [] });
    expect(nationwide?.evidence.map((entry) => entry.subject)).toEqual(['IDENTITY', 'APPLICATION_PERIOD']);
    expect(nationwide?.applicationPeriod).toEqual({ start: null, end: null, note: '예산 소진시까지' });
    // 날짜가 없으면 접수 중으로 추측하지 않는다.
    expect(nationwide?.observedApplicationStatus).toBe('UNKNOWN');
    expect(nationwide?.additionalChecks).toContain('기업마당 지원분야 표시: 금융');
    // 접수 시작 전인 공고도 접수 중이 아니다.
    expect(byId.get('PBLN_H')?.observedApplicationStatus).toBe('UNKNOWN');

    const versions = products.map((product) => ({ ...product, version: '1.0.0', reviewer: AUTO_REVIEWER }));
    const validation = validateFundingCatalog(catalogWith(versions), { asOfDate: AS_OF });
    expect(validation.issues).toEqual([]);
  });

  it('공고명 엔티티를 풀고, http 주소는 https로 읽는다', () => {
    const { products } = mapBizinfoItems(
      [
        item({
          pblancNm: '[서울] 소상공인 &amp; 예비창업자 &#8216;상생&#8217; 지원',
          pblancUrl: 'http://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000112345',
        }),
      ],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    );
    expect(products[0].name).toBe('[서울] 소상공인 & 예비창업자 ‘상생’ 지원');
    expect(products[0].officialUrl.startsWith('https://www.bizinfo.go.kr/')).toBe(true);
  });
});

describe('기업마당 API 수집기', () => {
  it('인증키로 전체 공고를 한 번에 받아 응답 checksum과 받은 공고 수를 남긴다', async () => {
    const response = body([item({ totCnt: 2 }), item({ pblancId: 'PBLN_OTHER', trgetNm: '중소기업', totCnt: 2 })]);
    const { promise, calls, logs } = collect([{ status: 200, body: response }]);
    const result = await promise;
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(BIZINFO_API_URL);
    expect(url.searchParams.get('crtfcKey')).toBe(API_KEY);
    expect(url.searchParams.get('dataType')).toBe('json');
    expect(url.searchParams.get('searchCnt')).toBe(String(BIZINFO_SEARCH_COUNT));
    expect(result.fetchedCount).toBe(2);
    expect(result.products).toHaveLength(1);
    expect(result.responseChecksum).toBe(createHash('sha256').update(response, 'utf8').digest('hex'));
    expect(result.products[0].evidence[0].checksum).toBe(result.responseChecksum);
    expect(logs.join('\n')).toContain('공고 2건 중 1건');
  });

  it('인증키가 없으면 요청하지 않고 실패한다', async () => {
    const { promise, calls } = collect([{ status: 200, body: body([item()]) }], '  ');
    await expect(promise).rejects.toThrow('BIZINFO_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('403·429는 다시 시도하지 않고 멈춘다', async () => {
    for (const status of [403, 429]) {
      const { promise, calls } = collect([{ status, body: `denied ${API_KEY}` }]);
      await expect(promise).rejects.toThrow(`HTTP ${status}`);
      expect(calls).toHaveLength(1);
    }
  });

  it('서버 오류와 연결 오류는 두 번까지 다시 시도한다', async () => {
    const recovered = collect([
      { status: 503, body: '' },
      new TypeError('fetch failed'),
      { status: 200, body: body([item()]) },
    ]);
    await expect(recovered.promise).resolves.toMatchObject({ fetchedCount: 1 });
    expect(recovered.calls).toHaveLength(3);

    const failed = collect([{ status: 500, body: '' }]);
    await expect(failed.promise).rejects.toThrow('3번 실패');
    expect(failed.calls).toHaveLength(3);
  });

  it('오류 문장에 인증키를 남기지 않는다', async () => {
    const { promise } = collect([{ status: 200, body: `<error>invalid key ${API_KEY}</error>` }]);
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toContain('JSON이 아닙니다');
    expect(error?.message).not.toContain(API_KEY);
    expect(error?.message).toContain('***');
  });

  it('공고 목록이 없거나 전체 건수보다 적게 받은 응답은 실패로 본다', async () => {
    const missing = collect([{ status: 200, body: JSON.stringify({ reqErr: 'invalid' }) }]);
    await expect(missing.promise).rejects.toThrow('jsonArray');

    const truncated = collect([{ status: 200, body: body([item({ totCnt: 1554 })]) }]);
    await expect(truncated.promise).rejects.toThrow('1554건 중 1건');
  });
});
