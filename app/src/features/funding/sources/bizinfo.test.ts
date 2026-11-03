import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FundingSourceCollection } from '../sync.ts';
import { AUTO_REVIEWER, FUNDING_CATALOG_SCHEMA_VERSION } from '../types.ts';
import { validateFundingCatalog } from '../validation.ts';
import {
  BIZINFO_API_URL,
  BIZINFO_SEARCH_COUNT,
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

describe('기업마당 신청기간 해석', () => {
  it('날짜 두 개로 적힌 신청기간만 날짜로 읽는다', () => {
    expect(parseBizinfoPeriod('2026-09-01 ~ 2026-10-31')).toEqual({ start: '2026-09-01', end: '2026-10-31' });
    expect(parseBizinfoPeriod(' 2026-09-01~2026-09-01 ')).toEqual({ start: '2026-09-01', end: '2026-09-01' });
    expect(parseBizinfoPeriod('예산 소진시까지')).toBeNull();
    expect(parseBizinfoPeriod('상시 접수')).toBeNull();
    expect(parseBizinfoPeriod('2026-02-30 ~ 2026-03-10')).toBeNull();
    expect(parseBizinfoPeriod('2026-10-31 ~ 2026-09-01')).toBeNull();
  });
});

describe('기업마당 공고를 카탈로그 상품으로 바꾸기', () => {
  it('사업 단계·지원 유형·지역을 추측하지 않고, 검증을 통과하는 상품을 만든다', () => {
    const { products, skipped } = mapBizinfoItems([item()], { asOfDate: AS_OF, responseChecksum: CHECKSUM });
    expect(skipped).toEqual({ notTarget: 0, ended: 0, malformed: 0, duplicate: 0 });
    expect(products).toHaveLength(1);
    const [product] = products;
    expect(product).toMatchObject({
      productKey: 'bizinfo-pbln-000000000112345',
      name: '[서울] 2026년 소상공인 디지털 전환 지원사업 공고',
      organization: '서울특별시 · 서울신용보증재단',
      supportType: 'UNKNOWN',
      eligibleBusinessStages: [],
      // 공고명 '[서울]'과 소관기관 '서울특별시'가 있어도 지역을 정하지 않는다. 대상 지역은 본문에서 AI가 읽는다(ADR 0009 §7).
      region: { scope: 'UNKNOWN', districtCodes: [] },
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
    ]);

    const version = { ...product, version: '1.0.0', reviewer: AUTO_REVIEWER };
    const validation = validateFundingCatalog(catalogWith([version]), { asOfDate: AS_OF });
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  // ADR 0009 §2: 지역으로는 거르지 않는다. 서울 밖으로 보이는 공고도 올리고, 대상 지역은 본문에서 AI가 읽는다.
  it('소상공인·창업벤처 대상이 아닌 공고, 끝난 공고, 형식이 깨진 공고와 중복은 빼고 세며, 서울 밖 공고는 빼지 않는다', () => {
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
        item({ pblancId: 'PBLN_H', reqstBeginEndDe: '2026-10-01 ~ 2026-10-31', pldirSportRealmLclasCodeNm: ' ' }),
      ],
      { asOfDate: AS_OF, responseChecksum: CHECKSUM },
    );
    expect(skipped).toEqual({ notTarget: 1, ended: 1, malformed: 3, duplicate: 1 });
    const byId = new Map(products.map((product) => [product.sourceRef.externalId, product]));
    expect([...byId.keys()]).toEqual(['PBLN_B', 'PBLN_C', 'PBLN_F', 'PBLN_G', 'PBLN_H']);
    // 공고명·소관기관(서울·서울 자치구·다른 시·도)으로 지역을 정하지 않는다. 지역 근거도 남기지 않는다(ADR 0009 §7).
    for (const [id, product] of byId) {
      expect(product.region, id).toMatchObject({ scope: 'UNKNOWN', districtCodes: [] });
      expect(
        product.evidence.map((entry) => entry.subject),
        id,
      ).toEqual(['IDENTITY', 'APPLICATION_PERIOD']);
    }

    expect(byId.get('PBLN_F')?.organization).toBe('서울특별시 중구');
    const nationwide = byId.get('PBLN_G');
    expect(nationwide?.applicationPeriod).toEqual({ start: null, end: null, note: '예산 소진시까지' });
    // 날짜가 없으면 접수 중으로 추측하지 않는다.
    expect(nationwide?.observedApplicationStatus).toBe('UNKNOWN');
    expect(nationwide?.additionalChecks).toContain('기업마당 지원분야 표시: 금융');
    // 지원분야는 정책자금·지원사업 갈래를 정하는 출처 항목이다(ADR 0009 §1). 값이 없으면 남기지 않는다.
    expect(nationwide?.sourceCategory).toBe('금융');
    expect(byId.get('PBLN_F')?.sourceCategory).toBe('경영');
    expect(byId.get('PBLN_H')).not.toHaveProperty('sourceCategory');
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

  // 본문의 부등호(&lt; &gt;)를 태그로 보고 지우면 "연매출 < 10억" 같은 조건이 사라진다.
  it('keeps escaped comparison signs in a raw HTML summary', () => {
    const [product] = mapBizinfoItems([item({ bsnsSumryCn: '<p>연매출 &lt; 10억, 업력 &gt; 3년</p>' })], {
      asOfDate: AS_OF,
      responseChecksum: CHECKSUM,
    }).products;
    expect(product.notice?.inline[0].text).toBe('연매출 < 10억, 업력 > 3년');
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
    // robots.txt는 넘김을 따라간다(RFC 9309 2.3.1.2). 공고 파일은 따라가지 않는다.
    expect(calls.map((call) => call.redirect)).toEqual(['follow', 'manual']);
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
