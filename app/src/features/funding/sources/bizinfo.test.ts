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
  bizinfoRobotsDisallowFiles,
  createBizinfoFileDownloader,
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
    expect(bizinfoRegion('소상공인 지원', '서울경제진흥원')).toMatchObject({ scope: 'SEOUL' });
    expect(bizinfoRegion('[경기] 소상공인 지원', '경기도')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('[충북 청주시] 소상공인 지원', '중소벤처기업부')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('소상공인 지원', '부산광역시 해운대구')).toEqual({ scope: 'OTHER' });
    // 서울 밖 같은 이름의 구는 자치구로 잡지 않는다.
    expect(bizinfoRegion('소상공인 지원', '대구광역시 중구')).toEqual({ scope: 'OTHER' });
    // 지역 신호가 없으면 전국으로 추측하지 않는다.
    expect(bizinfoRegion('소상공인 정책자금 공고', '중소벤처기업부')).toEqual({ scope: 'UNKNOWN' });
    expect(bizinfoRegion('[전국] 소상공인 정책자금 공고', '중소벤처기업부')).toEqual({ scope: 'UNKNOWN' });
  });

  // 2026-10-31 실제 수집에서 서울 밖 공고가 지역 미확인으로 들어왔다. 통합 시·도 이름과 'ㆍ'로 이은
  // 여러 지역 표시를 다른 시·도로 알아봐야 한다.
  it('통합 시·도 이름과 여러 지역 표시도 서울 밖으로 가린다', () => {
    expect(bizinfoRegion('[전남광주] 여수시 소상공인 융자금 이차보전', '전남광주통합특별시')).toEqual({
      scope: 'OTHER',
    });
    expect(bizinfoRegion('[전남광주ㆍ제주] 동행축제 라이브커머스', '중소벤처기업부')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('[대전·세종/충남] 소상공인 지원', '중소벤처기업부')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('[경기도 시흥시] 소상공인 지원', '중소벤처기업부')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('영세 소상공인 금융비용 지원', '전남광주통합특별시')).toEqual({ scope: 'OTHER' });
  });

  // 서울이 함께 적힌 공고는 서울 사용자가 신청할 수 있으므로 빼면 안 된다.
  it('지역 이름만 이은 표시에 서울이 있으면 순서와 상관없이 서울 공고로 남긴다', () => {
    for (const tag of ['경기ㆍ서울', '서울ㆍ경기', '경기∙서울', '경기・서울', '서울특별시']) {
      expect(bizinfoRegion(`[${tag}] 소상공인 지원`, '중소벤처기업부')).toMatchObject({ scope: 'SEOUL' });
    }
    expect(bizinfoRegion('[경기/서울] 소상공인 지원', '경기도')).toMatchObject({ scope: 'SEOUL' });
    // '서울시'는 서울을 적는 가장 흔한 표기다.
    expect(bizinfoRegion('[서울시] 소상공인 지원', '서울특별시')).toMatchObject({ scope: 'SEOUL' });
    expect(bizinfoRegion('[서울시 강남구] 소상공인 지원', '중소벤처기업부')).toMatchObject({
      scope: 'DISTRICTS',
      districtCodes: ['11680'],
    });
    expect(bizinfoRegion('[인천, 서울 강서구] 소상공인 지원', '중소벤처기업부')).toMatchObject({
      scope: 'DISTRICTS',
      districtCodes: ['11500'],
    });
  });

  // 지역 이름만 이은 목록이 아닌 표시는 서울이 대상인지 알 수 없다. 서울이 적혀 있어도 서울 공고로
  // 확정하지 않고(지역을 빼는 표시일 수 있다), 시·도 이름이 적혀 있어도 빼지 않는다(전국 공고일 수 있다).
  // 2026-10-31 리뷰에서 표기를 하나씩 막는 방식은 매번 새 표기가 빠져서 이렇게 정했다.
  it('지역 이름만 이은 목록이 아닌 표시는 서울로도 서울 밖으로도 단정하지 않는다', () => {
    for (const tag of [
      // 지역을 빼는 표시
      '비수도권(서울ㆍ경기ㆍ인천 제외)',
      '서울 제외',
      '서울 이외 지역',
      '서울외 지역',
      '서울 외의 지역',
      '비서울',
      '경기 제외',
      '경기 이외 지역',
      // 서울을 포함할 수도 있는 표시
      '경기+서울',
      '경기 및 서울',
      '수도권(서울ㆍ경기ㆍ인천)',
      '서울 외 3개 시도',
      // 시·도 이름으로 시작할 뿐인 낱말(경기 = 경제 상황)
      '경기회복',
      '경기 회복',
      '경기침체 극복',
      '대전환',
      '제주항공',
      // 시·군·구로 끝나지 않는 하위 지역은 지역 이름인지 낱말인지 가릴 수 없다
      '충북 청주',
      // 지역이 아닌 표시가 섞임
      '전남ㆍ전국',
      '서울 해외진출',
      '서울 강남구ㆍ서초구',
    ]) {
      expect(bizinfoRegion(`[${tag}] 소상공인 지원`, '중소벤처기업부'), tag).toEqual({ scope: 'UNKNOWN' });
    }
  });

  // 표시로 정할 수 없을 때 다른 시·도가 소관기관이면 그 시·도의 공고다. 서울 소관기관으로는 서울을
  // 확정하지 않는다('[전국(서울 제외)]'를 서울시가 올릴 수도 있다).
  it('표시로 정할 수 없으면 다른 시·도 소관기관만 서울 밖으로 본다', () => {
    expect(bizinfoRegion('[부산(기장군 제외)] 소상공인 지원', '부산광역시')).toEqual({ scope: 'OTHER' });
    // 서울이 적힌 표시는 다른 시·도 소관기관이어도 서울 사업자가 신청할 수 있을 수 있어 빼지 않는다.
    expect(bizinfoRegion('[서울 및 인천] 소상공인 지원', '인천광역시')).toEqual({ scope: 'UNKNOWN' });
    expect(bizinfoRegion('[수도권(서울ㆍ경기ㆍ인천)] 소상공인 지원', '경기도')).toEqual({ scope: 'UNKNOWN' });
    // 지역 이름 없이 지역을 빼는 표시도 서울 소관기관으로 서울을 확정하지 않는다.
    expect(bizinfoRegion('[수도권 제외] 소상공인 지원', '서울특별시')).toEqual({ scope: 'UNKNOWN' });
    expect(bizinfoRegion('[비수도권(수도권 이외)] 소상공인 지원', '서울특별시 강남구')).toEqual({ scope: 'UNKNOWN' });
    expect(bizinfoRegion('[지방 소재 기업(수도권 외)] 소상공인 지원', '서울특별시')).toEqual({ scope: 'UNKNOWN' });
    expect(bizinfoRegion('[수도권 제외] 소상공인 지원', '경기도')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('[전국(서울 제외)] 소상공인 지원', '서울특별시')).toEqual({ scope: 'UNKNOWN' });
    expect(bizinfoRegion('[서울 외 지역] 소상공인 지원', '서울특별시 중구')).toEqual({ scope: 'UNKNOWN' });
  });

  // 2026-10-31 리뷰: 흔한 서울 표기와 시·도 표기가 미확인으로 떨어지면 서울 공고의 지역 확인을 잃고
  // 서울 밖 공고가 후보에 섞인다. 지역을 빼거나 다른 시·도가 섞인 표시는 여전히 확정하지 않는다.
  it('흔한 서울·시·도 표기는 지역 이름으로 알아본다', () => {
    expect(bizinfoRegion('[서울강남구] 소상공인 지원', '중소벤처기업부')).toMatchObject({
      scope: 'DISTRICTS',
      districtCodes: ['11680'],
    });
    for (const tag of ['서울‧경기', '서울•경기']) {
      expect(bizinfoRegion(`[${tag}] 소상공인 지원`, '중소벤처기업부'), tag).toMatchObject({ scope: 'SEOUL' });
    }
    for (const tag of ['부산시', '인천시', '세종시', '제주도']) {
      expect(bizinfoRegion(`[${tag}] 소상공인 지원`, '중소벤처기업부'), tag).toEqual({ scope: 'OTHER' });
    }
    // 비수도권 대상 표시는 서울 소관기관이어도 서울이 아니다.
    for (const tag of ['비수도권', '수도권외', '수도권외 지역']) {
      expect(bizinfoRegion(`[${tag}] 소상공인 지원`, '서울특별시'), tag).toEqual({ scope: 'UNKNOWN' });
    }
    expect(bizinfoRegion('[비수도권] 소상공인 지원', '경기도')).toEqual({ scope: 'OTHER' });
    // 시·군·구 접미사 없는 하위 지역은 '[경기 회복]' 같은 낱말과 가릴 수 없어 미확인으로 남긴다(알려진 한계).
    expect(bizinfoRegion('[경기 광명] 소상공인 지원', '중소벤처기업부')).toEqual({ scope: 'UNKNOWN' });
  });

  // 2026-10-31 리뷰: 목록이 아닌 표시를 서울 소관기관으로 정하면 표시의 나머지(다른 자치구, 서울 전역,
  // 붙여 쓴 '외')를 무시해 엉뚱한 자치구나 서울로 확정했고, 시·도 뒤 '…시'·'…군'을 시·군으로 받으면
  // '[경기ㆍ스마트도시]'까지 서울 밖으로 뺐다. 서울 기관명 표시와 시·군만 이은 표시는 미확인으로 둔다.
  it('목록이 아닌 서울 표시를 소관기관으로 확정하지 않고, 시·도 없는 시·군 부분을 지역으로 받지 않는다', () => {
    const unknown: Array<[string, string]> = [
      ['[서울 강남구 일대] 지원', '서울특별시 서초구'],
      ['[서울 강남구ㆍ서초구] 지원', '서울특별시 강남구'],
      ['[서울 전역] 지원', '서울특별시 마포구'],
      ['[서울외 지역] 지원', '서울특별시'],
      ['[비서울] 지원', '서울특별시'],
      ['[서울신용보증재단] 소상공인 지원', '서울신용보증재단'],
      ['[서울 소상공인] 지원', '인천광역시'],
      ['[서울 및 인천] 소상공인 지원', '서울특별시'],
      ['[경기ㆍ스마트도시] 지원', '중소벤처기업부'],
      ['[경기ㆍ광역시] 지원', '중소벤처기업부'],
      ['[경남 창원시ㆍ김해시] 지원', '중소벤처기업부'],
    ];
    for (const [name, institution] of unknown) {
      expect(bizinfoRegion(name, institution), name).toEqual({ scope: 'UNKNOWN' });
    }
  });

  // 2026-11-02 리뷰: 자치구청이 올린 공고를 그 자치구 공고(DISTRICTS)로 정하면 다른 자치구 사용자는
  // 지역 조건 FAIL이 된다(eligibility.ts). 구청은 서울 전역·전국 공고도 옮겨 올리므로 소관기관은 서울이라는
  // 것만 알려 준다. 자치구는 공고명 표시가 서울 자치구 목록일 때만 정한다.
  it('자치구 소관기관은 서울만 알려 주고, 공고가 그 자치구만 대상인지는 정하지 않는다', () => {
    expect(bizinfoRegion('[서울] 지원', '서울특별시 마포구')).toEqual({
      scope: 'SEOUL',
      districtCodes: [],
      basis: "공고명 지역 표시 '[서울]'",
    });
    expect(bizinfoRegion('소상공인 지원', '서울특별시 동대문구')).toEqual({
      scope: 'SEOUL',
      districtCodes: [],
      basis: "소관기관 '서울특별시 동대문구'",
    });
    // 읽을 수 없는 표시에 지역 이름이 없으면 소관기관의 서울만 남는다.
    expect(bizinfoRegion('[전역] 지원', '서울특별시 마포구')).toMatchObject({ scope: 'SEOUL', districtCodes: [] });
    // 표시가 서울 자치구 목록이면 소관기관이 다른 자치구여도 표시를 따른다.
    expect(bizinfoRegion('[서울 강남구] 지원', '서울특별시 서초구')).toMatchObject({
      scope: 'DISTRICTS',
      districtCodes: ['11680'],
    });
  });

  // 서울 자치구 이름이 든 표시는 대상이 서울 전역보다 좁을 수 있어 서울로 넓히지도 않는다. 시·도 없는
  // '[마포구]'는 다른 시의 같은 이름 구('중구'·'서구' 등)와 가릴 수 없어 자치구로도 정하지 않는다.
  it('목록이 아닌 표시에 서울 자치구 이름이 있으면 소관기관과 상관없이 미확인이다', () => {
    const unknown: Array<[string, string]> = [
      ['[강남구 일대] 지원', '서울특별시 서초구'],
      ['[마포구] 지원', '서울특별시 마포구'],
      ['[성동구ㆍ광진구] 지원', '서울특별시'],
      ['[강서구 소재 기업] 지원', '중소벤처기업부'],
    ];
    for (const [name, institution] of unknown) {
      expect(bizinfoRegion(name, institution), name).toEqual({ scope: 'UNKNOWN' });
    }
    // 다른 시·도 소관기관이면 다른 시·도 이름이 있을 때처럼 뺀다. 다른 시에도 같은 이름의 구가 있다.
    expect(bizinfoRegion('[대구 중구 일대] 지원', '대구광역시')).toEqual({ scope: 'OTHER' });
    expect(bizinfoRegion('[중구 일대] 지원', '부산광역시 중구')).toEqual({ scope: 'OTHER' });
  });

  // 2026-11-02 리뷰: '[서울] 은평구 …'처럼 공고명이 자치구를 적은 공고를 서울로 정하면 다른 자치구 사용자도
  // 지역 조건이 통과로 보인다. 2026-10-31 실제 수집에서 은평구·종로구·서대문구 공고 3건이 그랬다. 자치구는
  // '[서울 ○○구]' 표시로만 정하므로, 그 밖에 공고명이 서울 자치구를 적으면 서울로 정하지 않고 미확인으로 둔다.
  it('공고명이 서울 자치구를 적으면 서울로 확정하지 않는다', () => {
    const unknown: Array<[string, string]> = [
      ['[서울] 은평구 2026년 소규모 자영업자 LED간판 설치 지원사업 공고', '서울특별시'],
      ['[서울] 2025년 하반기 강남구 중소기업육성기금 융자 지원 공고', '서울특별시 강남구'],
      ['[서울시] 종로구 소상공인 라이브커머스 지원', '서울특별시'],
      ['2026년 마포구 소상공인 경영안정자금 지원', '서울특별시 마포구'],
      ['[소상공인] 마포구청 지원', '서울특별시 마포구'],
      ['서대문구(청년창업) 전문상담 모집', '서울특별시'],
    ];
    for (const [name, institution] of unknown) {
      expect(bizinfoRegion(name, institution), name).toEqual({ scope: 'UNKNOWN' });
    }
    // '[서울 ○○구]' 표시는 공고명에 그 자치구가 다시 적혀도 자치구다.
    expect(bizinfoRegion('[서울 강남구] 강남구 소상공인 지원', '서울특별시 강남구')).toMatchObject({
      scope: 'DISTRICTS',
      districtCodes: ['11680'],
    });
  });

  // 자치구 이름이 낱말 안에 있을 뿐이면('집중구매'의 '중구') 자치구를 적은 것이 아니다.
  it('낱말 안의 자치구 이름은 자치구로 보지 않는다', () => {
    expect(bizinfoRegion('[집중구매] 지원', '서울특별시')).toMatchObject({ scope: 'SEOUL' });
    expect(bizinfoRegion('[서울] 집중구매 소상공인 지원', '중소벤처기업부')).toMatchObject({ scope: 'SEOUL' });
    expect(bizinfoRegion('신중구상 소상공인 지원', '서울특별시')).toMatchObject({ scope: 'SEOUL' });
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
      // 자치구 소관기관은 서울만 알려 준다.
      region: { scope: 'SEOUL', districtCodes: [], note: null },
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

// ADR 0009 §2: 사업개요와 본문출력파일·첨부를 본문 계획으로 넘긴다. 주소 형식은 기업마당 API 명세의 예시다.
describe('기업마당 공고의 본문 계획', () => {
  const PRINT = 'https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000613694&fileSn=1';
  const ATTACH = 'https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000613641&fileSn=0';

  it('holds the API summary, the print file and the attachment', () => {
    const [product] = mapBizinfoItems(
      [
        item({
          bsnsSumryCn: '<p>서울 소재 소상공인의&nbsp;디지털 전환을 지원합니다.</p><p>대표자 만 39세 이하</p>',
          printFlpthNm: PRINT,
          printFileNm: '2026년 디지털 전환 공고.pdf',
          flpthNm: ATTACH,
          fileNm: '신청서 양식.hwp',
        }),
      ],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    ).products;
    expect(product.notice).toEqual({
      sourceUrl: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000112345',
      inline: [
        {
          kind: 'API_SUMMARY',
          name: '기업마당 사업개요',
          url: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000112345',
          text: '서울 소재 소상공인의 디지털 전환을 지원합니다.\n대표자 만 39세 이하',
        },
      ],
      files: [
        { kind: 'PRINT_FILE', name: '2026년 디지털 전환 공고.pdf', url: PRINT },
        { kind: 'ATTACHMENT', name: '신청서 양식.hwp', url: ATTACH },
      ],
    });
  });

  // 2026-11-03 실제 응답: 여러 파일은 '@'로 잇고, 주소마다 호출 때마다 새로 발급되는 downloadToken이 붙는다.
  it('splits files joined with @ and keeps the download token out of the stored address', () => {
    const token = (n: number) =>
      `${ATTACH.replace('fileSn=0', `fileSn=${n}`)}&downloadToken=eyJhbGciOiJIUzI1NiJ9.e30.sig${n}`;
    const [product] = mapBizinfoItems(
      [
        item({
          printFlpthNm: `${PRINT}&downloadToken=eyJhbGciOiJIUzI1NiJ9.e30.print`,
          printFileNm: '공고문.pdf',
          flpthNm: `${token(1)}@${token(2)}`,
          fileNm: '공고문.hwpx@모집포스터.pdf',
        }),
      ],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    ).products;
    expect(product.notice?.files).toEqual([
      {
        kind: 'PRINT_FILE',
        name: '공고문.pdf',
        url: PRINT,
        downloadUrl: `${PRINT}&downloadToken=eyJhbGciOiJIUzI1NiJ9.e30.print`,
      },
      { kind: 'ATTACHMENT', name: '공고문.hwpx', url: ATTACH.replace('fileSn=0', 'fileSn=1'), downloadUrl: token(1) },
      {
        kind: 'ATTACHMENT',
        name: '모집포스터.pdf',
        url: ATTACH.replace('fileSn=0', 'fileSn=2'),
        downloadUrl: token(2),
      },
    ]);
  });

  it('does not pair names with the wrong files when the counts differ', () => {
    const [product] = mapBizinfoItems(
      [item({ printFlpthNm: '', printFileNm: '', flpthNm: `${ATTACH}@${PRINT}`, fileNm: '하나뿐인 이름.pdf' })],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    ).products;
    // 이름을 믿을 수 없으면 형식을 알 수 없는 파일로 남긴다(받지 않는다).
    expect(product.notice?.files.map((file) => file.name)).toEqual(['', '']);
  });

  it('reads a summary whose HTML arrives escaped, and does not fail on broken entities', () => {
    const [product] = mapBizinfoItems(
      [item({ bsnsSumryCn: '&lt;p&gt;소상공인 지원&lt;/p&gt;&lt;p&gt;대표자 &amp; 공동대표&lt;/p&gt;&#1114112;&#0;' })],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    ).products;
    const text = product.notice?.inline[0].text ?? '';
    expect(text).toContain('소상공인 지원');
    expect(text).toContain('대표자 & 공동대표');
    expect(text).not.toMatch(/<\/?p>/);
  });

  // 파일 받기는 www.bizinfo.go.kr의 공고 파일 경로만 요청한다. 계획에 다른 주소를 넣으면 날마다 실패로 남아
  // 본문을 다시 쓰지 못한다.
  it('plans only Bizinfo file paths, and reads bizinfo.go.kr without www as the same host', () => {
    const [product] = mapBizinfoItems(
      [
        item({
          printFlpthNm: 'https://bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_1&fileSn=0',
          printFileNm: '공고문.pdf',
          flpthNm: 'https://www.bizinfo.go.kr/web/other.do?x=1@https://www.mss.go.kr/file.pdf',
          fileNm: '다른 페이지.pdf@다른 기관.pdf',
        }),
      ],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    ).products;
    expect(product.notice?.files.map((file) => file.url)).toEqual([
      'https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_1&fileSn=0',
    ]);
  });

  it('leaves out file links that are not official Bizinfo addresses', () => {
    const [product] = mapBizinfoItems(
      [item({ printFlpthNm: 'https://example.com/a.pdf', printFileNm: 'a.pdf', flpthNm: '', fileNm: '' })],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    ).products;
    expect(product.notice?.files).toEqual([]);
  });
});

// ADR 0009 §2와 ADR 0006 3절의 수집 규칙: robots.txt 확인, 요청 간격, 403·429에서 멈춤, 운영자 연락처.
describe('기업마당 공고 파일 받기', () => {
  const FILE = 'https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000700001&fileSn=0';
  const FILE2 = 'https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000700001&fileSn=1';
  type Reply = { status: number; body?: string } | Error;

  function files(routes: Record<string, Reply | Reply[]>, contact: string | undefined = 'ops@example.com') {
    const calls: Array<{ url: string; userAgent: string | undefined; redirect: string | undefined }> = [];
    const sleeps: number[] = [];
    const counts = new Map<string, number>();
    const download = createBizinfoFileDownloader({
      contact,
      retryDelayMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, userAgent: init.headers['User-Agent'], redirect: init.redirect });
        const route = routes[url] ?? { status: 404 };
        const index = counts.get(url) ?? 0;
        counts.set(url, index + 1);
        const reply = Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route;
        if (reply instanceof Error) throw reply;
        const bytes = new TextEncoder().encode(reply.body ?? '');
        return { status: reply.status, arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer };
      },
    });
    return { download, calls, sleeps };
  }

  it('checks robots.txt first, names the operator and waits between requests', async () => {
    const { download, calls, sleeps } = files({
      'https://www.bizinfo.go.kr/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /admin/\n' },
      [FILE]: { status: 200, body: '%PDF-1.7 공고문' },
      [FILE2]: { status: 200, body: '%PDF-1.7 별표' },
    });
    expect(await download(FILE)).toMatchObject({ ok: true });
    expect(await download(FILE2)).toMatchObject({ ok: true });
    expect(calls.map((call) => call.url)).toEqual(['https://www.bizinfo.go.kr/robots.txt', FILE, FILE2]);
    expect(calls.every((call) => call.userAgent?.includes('ops@example.com'))).toBe(true);
    // 첫 요청 뒤의 요청마다 1초 이상 쉰다.
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms >= 1000)).toBe(true);
  });

  it('does not download files that robots.txt disallows', async () => {
    const { download, calls } = files({
      'https://www.bizinfo.go.kr/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /cmm/fms/\n' },
    });
    // 다음 동기화에서 다시 확인하도록 일시 실패로 돌려준다. 직전 본문은 그대로 쓴다.
    expect(await download(FILE)).toMatchObject({
      ok: false,
      transient: true,
      message: expect.stringContaining('robots.txt'),
    });
    expect(calls.map((call) => call.url)).toEqual(['https://www.bizinfo.go.kr/robots.txt']);
  });

  it.each([
    ['a wildcard rule', 'User-agent: *\nDisallow: /*.do\n', true],
    ['a rule for the whole site', 'User-agent: *\nDisallow: /\n', true],
    ['a longer Allow rule', 'User-agent: *\nDisallow: /cmm/\nAllow: /cmm/fms/\n', false],
    ['a rule only for another robot', 'User-agent: Googlebot\nDisallow: /\n', false],
    ['an end-anchored rule that does not match', 'User-agent: *\nDisallow: /cmm/fms/$\n', false],
  ])('reads robots.txt with %s', (_, robots, blocked) => {
    expect(bizinfoRobotsDisallowFiles(robots)).toBe(blocked);
  });

  // 다른 경로로 넘어가는 응답을 따라가지 않는다. 그 경로가 robots.txt에 막혀 있을 수 있다.
  it('does not follow redirects', async () => {
    const { download, calls } = files({
      'https://www.bizinfo.go.kr/robots.txt': { status: 404 },
      [FILE]: { status: 302 },
    });
    expect(await download(FILE)).toMatchObject({ ok: false, transient: false });
    expect(calls.map((call) => call.redirect)).toEqual(['manual', 'manual']);
  });

  it('stops requesting after 403 or 429', async () => {
    const { download, calls } = files({
      'https://www.bizinfo.go.kr/robots.txt': { status: 404 },
      [FILE]: { status: 429 },
      [FILE2]: { status: 200, body: '%PDF-1.7' },
    });
    expect(await download(FILE)).toMatchObject({ ok: false, transient: true });
    expect(await download(FILE2)).toMatchObject({ ok: false, transient: true });
    expect(calls.map((call) => call.url)).toEqual(['https://www.bizinfo.go.kr/robots.txt', FILE]);
  });

  it('treats a missing file as permanent and retries server errors before giving up for this sync', async () => {
    const { download, calls } = files({
      'https://www.bizinfo.go.kr/robots.txt': { status: 404 },
      [FILE]: { status: 404 },
      [FILE2]: [{ status: 503 }, new TypeError('fetch failed'), { status: 502 }],
    });
    expect(await download(FILE)).toMatchObject({ ok: false, transient: false });
    expect(await download(FILE2)).toMatchObject({ ok: false, transient: true });
    expect(calls.filter((call) => call.url === FILE2)).toHaveLength(3);
  });

  it('only requests Bizinfo file paths', async () => {
    const { download, calls } = files({ 'https://www.bizinfo.go.kr/robots.txt': { status: 404 } });
    expect(await download('https://example.com/cmm/fms/getImageFile.do?atchFileId=X')).toMatchObject({
      ok: false,
      transient: false,
    });
    expect(await download('https://www.bizinfo.go.kr/web/lay1/bbs/view.do')).toMatchObject({
      ok: false,
      transient: false,
    });
    expect(calls).toEqual([]);
  });

  it('does not download without an operator contact', async () => {
    const { download, calls } = files({}, '');
    expect(await download(FILE)).toMatchObject({
      ok: false,
      transient: true,
      message: expect.stringContaining('FUNDING_SYNC_CONTACT'),
    });
    expect(calls).toEqual([]);
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
