import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateProduct } from '../eligibility.ts';
import type { FundingSourceCollection } from '../sync.ts';
import { AUTO_REVIEWER, FUNDING_CATALOG_SCHEMA_VERSION } from '../types.ts';
import { validateFundingCatalog } from '../validation.ts';
import {
  SEMAS_OLS_MIN_REQUEST_INTERVAL_MS,
  SEMAS_OLS_URLS,
  createSemasOlsAdapter,
  isSemasFundNotice,
  mapSemasFunds,
  parseSemasHomeCards,
  parseSemasNoticeDetail,
  parseSemasNoticePage,
  parseSemasOverview,
  parseSemasPeriod,
  parseSemasSingleLimit,
  selectSemasFundNotices,
  semasFundExternalId,
  semasFundProductKey,
  semasNoticeUrl,
  semasUserAgent,
  type SemasFetch,
  type SemasNotice,
  type SemasFundNotice,
} from './semas-ols.ts';

// 사이트 원문이 아니라 파서가 기대는 구조만 남긴 HTML 조각이다(ADR 0006 Validation).
const AS_OF = '2026-09-29';
const CONTACT = 'ops@example.com';

function fundRow(name: string, requirement: string, term: string, limit: string, rate: string): string {
  return `<tr><td>${name}</td><td class="tl">${requirement}</td><td>${term}</td><td>${limit}</td><td>${rate}</td></tr>`;
}

function fundTable(
  heading: string,
  rows: readonly string[],
  columns = ['자금명', '신청요건', '대출기간', '대출한도', '대출금리'],
): string {
  const [first, second, ...rest] = columns;
  return `<h3>${heading}</h3>
<div class="table_scroll mo_scroll_moveimg"><table class="p-table scrollcol">
<caption>세부 지원요건 목록</caption>
<colgroup><col style="width: 13%;"><col style="width: 47%;"></colgroup>
<thead><tr><th scope="col">${first}</th><th scope="col">${second}<br> <span class="c_red">* 세부 신청요건은 반드시 공지사항을 참고하시기 바랍니다.</span></th>${rest.map((column) => `<th scope="col">${column}</th>`).join('')}</tr></thead>
<tbody>
${rows.join('\n')}
</tbody></table></div>`;
}

const QUALIFICATION = `<h3>공통 지원자격</h3>
<ul class="ul_type01 mb3r">
<li>[소상공인 보호 및 지원에 관한 법률]상 소상공인: 상시근로자 5인 미만 업체<br>(제조업, 건설업, 운수업, 광업: 상시근로자 10인 미만 업체)</li>
<li>제외업종: 유흥 향락 업종, 전문업종, 금융업, 보험업, 부동산업 등</li>
</ul>`;

const RATE_NOTES = `<h3>금리 안내사항</h3>
<ul class="ul_type01 mb3r"><li>대출금리 : 기준금리(분기별 변동)+ 가산금리</li><li>\`26년 3/4 분기 정책자금 기준금리 : 3.85%</li></ul>`;

const DIRECT_ROWS = [
  fundRow(
    '혁신성장촉진자금',
    '<span class="fw-bold">(혁신형)</span> 수출, 스마트 공장 도입<br><span class="fw-bold">(일반형)</span> 백년소상공인',
    '(운전) 5년<br><span style="font-size:14px;">(비거치 또는 거치 2년 이내)</span><br>(시설) 8년',
    '(일반형)<br>운전 1억원,시설 5억원',
    '기준금리+0.4%P',
  ),
  fundRow(
    '일시적경영애로자금',
    '연매출 1억 4백만원 미만이고 업력 7년 미만이면서 일시적경영애로 사유가 있는 소상공인',
    '5년(거치 2년)',
    '7천만원',
    '기준금리+0.0%P',
  ),
];

const AGENCY_ROWS = [
  fundRow('일반경영안정자금', '업력무관 소상공인', '5년(거치 2년)', '7천만원', '기준금리+0.6%P'),
  fundRow(
    '소공인특화자금',
    '제조업을 영위하는 상시근로자수 10인 미만의 소공인',
    '(운전) 5년(거치 2년)<br>(시설) 8년(거치 3년)',
    '(운전) 1억원<br>(시설) 5억원',
    '기준금리+0.6%P',
  ),
  fundRow('장애인기업지원자금', '장애인기업확인서를 소지한 장애 소상공인', '7년(거치2년)', '1억원', '고정금리(2.0%P)'),
  fundRow(
    '대환대출',
    '중&#8729;저신용 소상공인',
    '10년<span>(비거치 또는 거치2년)</span>',
    '5천만원',
    '고정금리(4.5%P)',
  ),
];

function overviewHtml(options: { qualification?: string; direct?: string; agency?: string } = {}): string {
  return `<html><body><div class="content" id="contents">
<div class="cont_title"><h2><span>정책자금한눈에보기</span></h2></div>
${options.qualification ?? QUALIFICATION}
${RATE_NOTES}
${options.direct ?? fundTable('2026년 정책자금 직접대출 세부 지원요건', DIRECT_ROWS)}
${options.agency ?? fundTable('2026년 정책자금 대리대출 세부 지원요건', AGENCY_ROWS)}
<ul class="ul_type01 mb3r"><li> 각 자금별 접수 순서대로 처리, 예산 소진 시 마감</li></ul>
</div></body></html>`;
}

function card(kind: 'jd' | 'dd' | 'repay', name: string, period: string, status = '접수중'): string {
  const label = kind === 'jd' ? '직접대출' : kind === 'dd' ? '대리대출' : '상환연장';
  const className = kind === 'repay' ? 'jd_loan' : `${kind}_loan`;
  return `<div onclick="location.href='/ols/pfa/SPFA301M/page.do'" class="${className}"><div class="slide"><div class="loan_info_wrap">
<p class="${kind}_title"><span>${label}</span></p><p class="info_ing"><span>${status}</span></p></div>
<p class="loan_type">${name}</p><p class="loan_date">${period}</p>
<button type="button" class="loan_btn"><span>신청하기</span></button></div></div>`;
}

const HOME_CARDS = [
  card('repay', '정책자금 상환연장', '상시접수'),
  card('dd', '소상공인 대환대출', '접수기간 : 2026-01-05 ~ 자금소진시까지'),
  card('dd', '소공인특화자금', '접수기간 : 2026-01-05 ~ 자금소진시까지'),
  card('jd', '일시적경영애로자금(홈플러스 피해 소상공인)', '접수기간 : 2026-07-15 ~ 자금소진시까지'),
  card('jd', '혁신성장촉진자금(사회연대경제조직)', '접수기간 : 2026-01-12 ~ 자금소진시까지'),
];

function homeHtml(cards: readonly string[] = HOME_CARDS): string {
  return `<html><body><div class="group1_1 "><div class="loan_wrap"><div class="content"><div class="loan_wrap_inner">
<h2><i>정책자금</i> 신청하기 <span class="subtxt">소상공인시장진흥공단에서 지원하는 정책자금을 확인하세요</span></h2>
<div class="info_slide-wrap"><div class="slide_inner">
${cards.join('\n')}
</div></div>
</div></div></div></div></body></html>`;
}

function listItem(seq: number, section: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    bltwtrTitNm: title,
    rnum: 1,
    bltwtrClcd: '대출정보',
    bltwtrSeq: seq,
    bbsTypeCd: '01',
    loanSeCdNm: section,
    bbsFxnYn: 'N',
    frstRegDt: '2026-09-11',
    ...overrides,
  };
}

const LIST_ITEMS = [
  listItem(404, '대리대출', '2026년 4분기 일반경영안정자금(대리대출) 접수 안내'),
  listItem(386, '직접대출', '2026년 일시적경영애로자금(홈플러스 피해 소상공인) 직접대출 신청안내(수정)'),
  listItem(338, '직접대출', '신용취약소상공인자금 금리인하제도 신청안내'),
  listItem(326, '대리대출', '2026년 소공인특화자금(일반)(대리대출) 접수 안내'),
  listItem(325, '대리대출', '2026년 소상공인 대환대출(대리대출) 접수 안내'),
  listItem(400, '직접대출', '소상공인 정책자금 직접대출 신청서류 웹폼 전환 안내', { bltwtrClcd: '서비스안내' }),
  listItem(402, '직접대출', '2026년 9월 일시적경영애로자금(직접대출) 신청안내'),
  listItem(393, '직접대출', "[필독] 혁신성장촉진자금 접수방식 변경 안내 ('26.8월~)"),
  listItem(396, '직접대출', '2026년 3분기 혁신성장촉진자금 신청안내(수정)'),
  listItem(380, '대리대출', '2026년 3분기 일반경영안정자금(대리대출) 접수 안내'),
  listItem(354, '대리대출', '2026년 2분기 일반경영안정자금(대리대출) 접수 안내'),
];

function listPage(items: readonly unknown[], pageNo: number, pageSize = 10, totalCount = items.length): string {
  const slice = items.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return JSON.stringify({
    result: slice,
    pagination: { vTotalPage: Math.ceil(totalCount / pageSize), totalCount, vPageNo: pageNo, pageSize },
  });
}

function detailHtml(title: string, lines: readonly string[]): string {
  return `<html><body><div class="board_view"><p class="view_title">${title}</p>
<ul class="write_info"><li><strong>구분 : &nbsp;</strong>대출정보</li></ul>
<div class="file_down"><h5>첨부파일</h5><ul><li><a href="javascript:void(0);" onclick="fnDownFile(1)">신청안내자료.pdf</a></li></ul></div>
<div class="board_con"><div id="cntnDiv" style="min-height:500px; border: 0px;">${lines.join('<br>')}</div>
</div></div></body></html>`;
}

const DETAILS: Record<number, string> = {
  404: detailHtml('2026년 4분기 일반경영안정자금(대리대출) 접수 안내', [
    '□ 신청대상 : 업력 무관 소상공인',
    '',
    '□ 접수기간 : 2026. 10. 6.(화) 10:00 ~ 예산소진 시까지',
    ' * 예산 소진시 조기마감',
  ]),
  402: detailHtml('2026년 9월 일시적경영애로자금(직접대출) 신청안내', [
    '일시적경영애로자금(직접대출)의 지원대상은 연매출 1억 4백만원 미만이고 업력 7년 미만이면서 일시적경영애로 사유가 있는 소상공인입니다.',
    '□  접수기간 : 2026년 9월 7일 (월) 10:00 ~ 예산 소진 시까지',
  ]),
  396: detailHtml('2026년 3분기 혁신성장촉진자금 신청안내(수정)', ['□  신청기간 : ‘26. 8. 10.(월), 10:00 ~ 18:00']),
  326: detailHtml('2026년 소공인특화자금(일반)(대리대출) 접수 안내', [
    '□ 신청대상 : 제조업을 영위하는 상시근로자수 10인 미만 소공인',
    '□ 접수기간 : 2026. 1. 5.(월) 10:00 ~ 예산소진 시까지',
  ]),
  325: detailHtml('2026년 소상공인 대환대출(대리대출) 접수 안내', [
    '□ 신청대상 : NCB개인신용평점 919점 이하 중·저신용 소상공인',
    '□ 접수기간 : 2026. 1. 5.(월) 10:00 ~ 예산소진 시까지',
  ]),
};

type Reply = { status: number; body: string } | Error;
type Call = { url: string; method: string; body: string | undefined; headers: Record<string, string> };
type Routes = {
  robots: () => Reply;
  overview: () => Reply;
  home: () => Reply;
  list: (pageNo: number) => Reply;
  detail: (seq: number) => Reply;
};

const DEFAULT_ROUTES: Routes = {
  robots: () => ({ status: 404, body: 'Not Found' }),
  overview: () => ({ status: 200, body: overviewHtml() }),
  home: () => ({ status: 200, body: homeHtml() }),
  list: (pageNo) => ({ status: 201, body: listPage(LIST_ITEMS, pageNo) }),
  detail: (seq) => (DETAILS[seq] ? { status: 200, body: DETAILS[seq] } : { status: 404, body: '' }),
};

function siteFetch(overrides: Partial<Routes> = {}): { fetchImpl: SemasFetch; calls: Call[] } {
  const routes = { ...DEFAULT_ROUTES, ...overrides };
  const calls: Call[] = [];
  const fetchImpl: SemasFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const parsed = new URL(url);
    const target = `${parsed.origin}${parsed.pathname}`;
    let reply: Reply;
    if (target === SEMAS_OLS_URLS.robots) reply = routes.robots();
    else if (target === SEMAS_OLS_URLS.overview) reply = routes.overview();
    else if (target === SEMAS_OLS_URLS.home) reply = routes.home();
    else if (target === SEMAS_OLS_URLS.noticeList) {
      reply = routes.list(Number(new URLSearchParams(init.body ?? '').get('pageNo')));
    } else if (target === SEMAS_OLS_URLS.noticeDetail) {
      reply = routes.detail(Number(parsed.searchParams.get('bltwtrSeq')));
    } else reply = { status: 404, body: '' };
    if (reply instanceof Error) throw reply;
    const { status, body } = reply;
    return { status, text: async () => body };
  };
  return { fetchImpl, calls };
}

// options.contact를 undefined로 넘기면 연락처가 없는 경우다. options를 생략해야 기본 연락처를 쓴다.
function collect(
  overrides: Partial<Routes> = {},
  options: { contact: string | undefined } = { contact: CONTACT },
): { promise: Promise<FundingSourceCollection>; calls: Call[]; sleeps: number[]; logs: string[] } {
  const { contact } = options;
  const { fetchImpl, calls } = siteFetch(overrides);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const adapter = createSemasOlsAdapter({
    contact,
    fetchImpl,
    retryDelayMs: 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { promise: adapter.collect({ asOfDate: AS_OF, log: (message) => logs.push(message) }), calls, sleeps, logs };
}

const FRESH_SYNC = {
  source: 'SEMAS_OLS',
  status: 'SUCCEEDED',
  attemptedAt: `${AS_OF}T01:00:00.000Z`,
  lastSucceededOn: AS_OF,
  fetchedCount: 6,
  responseChecksum: 'c'.repeat(64),
  failureReason: null,
};

function catalogWith(products: unknown[], automation: Record<string, unknown> = {}) {
  return {
    catalogKey: 'test-semas-catalog',
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    catalogVersion: `${AS_OF}.1`,
    basisDate: AS_OF,
    reviewer: 'tester',
    notes: [],
    automation: {
      policyLoanPromotion: false,
      repaymentPromotion: false,
      blockedSources: [],
      sourceSyncs: [FRESH_SYNC],
      ...automation,
    },
    products,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function detailsFor(
  rows: ReturnType<typeof parseSemasOverview>['rows'],
  notices: readonly SemasNotice[],
): Map<string, SemasFundNotice> {
  const selected = selectSemasFundNotices(rows, notices);
  const details = new Map<string, SemasFundNotice>();
  for (const [key, notice] of selected) {
    const html = DETAILS[notice.seq];
    details.set(key, { notice, detail: parseSemasNoticeDetail(html), checksum: sha256(html) });
  }
  return details;
}

function mapDefault(options: { cards?: readonly string[]; asOfDate?: string; overview?: string } = {}) {
  const overviewPage = options.overview ?? overviewHtml();
  const homePage = homeHtml(options.cards);
  const overview = parseSemasOverview(overviewPage);
  const notices = parseSemasNoticePage(listPage(LIST_ITEMS, 1, 100)).notices;
  const mapping = mapSemasFunds(
    {
      overview,
      cards: parseSemasHomeCards(homePage),
      notices: detailsFor(overview.rows, notices),
      pageChecksums: { overview: sha256(overviewPage), home: sha256(homePage) },
    },
    { asOfDate: options.asOfDate ?? AS_OF },
  );
  const byName = new Map(mapping.products.map((product) => [product.name, product]));
  return { mapping, byName };
}

const POST_REGISTRATION_PROFILE = {
  businessStage: 'POST_REGISTRATION',
  districtCode: '11140',
  industryCode: 'CS100010',
  purpose: 'OPERATING_FUNDS',
} as const;

describe('소진공 접수기간 해석', () => {
  it('종료일 없는 접수, 날짜 두 개, 하루 접수를 읽는다', () => {
    expect(parseSemasPeriod('2026. 10. 6.(화) 10:00 ~ 예산소진 시까지')).toEqual({
      start: '2026-10-06',
      end: null,
      openEndedNote: '예산소진 시까지',
    });
    expect(parseSemasPeriod('2026년 9월 7일 (월) 10:00 ~ 예산 소진 시까지')).toMatchObject({
      start: '2026-09-07',
      end: null,
    });
    expect(parseSemasPeriod('‘26년 1월 12일(월) 10:00 ~ 예산 소진 시까지')).toMatchObject({
      start: '2026-01-12',
      end: null,
    });
    expect(parseSemasPeriod('2026-01-05 ~ 자금소진시까지')).toEqual({
      start: '2026-01-05',
      end: null,
      openEndedNote: '자금소진시까지',
    });
    expect(parseSemasPeriod('‘26. 8. 18.(화) ~ 8. 19.(수), 10:00 ~ 18:00')).toEqual({
      start: '2026-08-18',
      end: '2026-08-19',
      openEndedNote: null,
    });
    expect(parseSemasPeriod('2026-01-05 ~ 2026-10-30')).toMatchObject({ start: '2026-01-05', end: '2026-10-30' });
    expect(parseSemasPeriod('2026. 12. 28.(월) ~ 1. 5.(화)')).toMatchObject({ start: '2026-12-28', end: '2027-01-05' });
    expect(parseSemasPeriod('‘26. 8. 10.(월), 10:00 ~ 18:00')).toEqual({
      start: '2026-08-10',
      end: '2026-08-10',
      openEndedNote: null,
    });
  });

  it('날짜가 없거나 모호한 표기는 추측하지 않는다', () => {
    expect(parseSemasPeriod('상시접수')).toBeNull();
    expect(parseSemasPeriod('예산 소진 시까지')).toBeNull();
    expect(parseSemasPeriod('2026. 2. 30.(월) ~ 예산소진 시까지')).toBeNull();
    expect(parseSemasPeriod('2026. 10. 6.(화) 10:00부터')).toBeNull();
    expect(parseSemasPeriod('8. 18. ~ 8. 19.')).toBeNull();
    expect(parseSemasPeriod('2026. 10. 12. ~ 10. 13. / 2026. 10. 26. ~ 예산 소진 시까지')).toBeNull();
    expect(parseSemasPeriod('2026-10-30 ~ 2026-10-01')).toBeNull();
  });
});

describe('정책자금 한눈에 보기 표', () => {
  it('섹션별 자금 행, 공통 지원자격, 기준금리를 읽는다', () => {
    const overview = parseSemasOverview(overviewHtml());
    expect(overview.rows.map((row) => [row.section, row.name])).toEqual([
      ['직접대출', '혁신성장촉진자금'],
      ['직접대출', '일시적경영애로자금'],
      ['대리대출', '일반경영안정자금'],
      ['대리대출', '소공인특화자금'],
      ['대리대출', '장애인기업지원자금'],
      ['대리대출', '대환대출'],
    ]);
    expect(overview.rows[0]).toMatchObject({
      heading: '2026년 정책자금 직접대출 세부 지원요건',
      requirement: '(혁신형) 수출, 스마트 공장 도입 (일반형) 백년소상공인',
      term: '(운전) 5년 (비거치 또는 거치 2년 이내) (시설) 8년',
      limit: '(일반형) 운전 1억원,시설 5억원',
      rate: '기준금리+0.4%P',
    });
    expect(overview.rows[5].requirement).toBe('중∙저신용 소상공인');
    expect(overview.baseRate).toBe('`26년 3/4 분기 정책자금 기준금리 : 3.85%');
    expect(overview.excludedIndustries).toBe('제외업종: 유흥 향락 업종, 전문업종, 금융업, 보험업, 부동산업 등');
    expect(overview.qualification[0]).toContain('소상공인 보호 및 지원에 관한 법률');
  });

  it('필수 항목을 찾지 못하면 실패한다', () => {
    expect(() => parseSemasOverview(overviewHtml({ qualification: '' }))).toThrow('공통 지원자격');
    expect(() =>
      parseSemasOverview(
        overviewHtml({
          direct: fundTable('2026년 정책자금 직접대출 세부 지원요건', DIRECT_ROWS, [
            '자금명',
            '신청요건',
            '대출기간',
            '대출한도',
            '금리',
          ]),
        }),
      ),
    ).toThrow('머리글이 예상과 다릅니다');
    expect(() =>
      parseSemasOverview(overviewHtml({ direct: fundTable('2026년 정책자금 세부 지원요건', DIRECT_ROWS) })),
    ).toThrow('직접대출인지 대리대출인지');
    expect(() =>
      parseSemasOverview(
        overviewHtml({
          direct: fundTable('2026년 정책자금 직접대출 세부 지원요건', [
            '<tr><td>혁신성장촉진자금</td><td>요건</td></tr>',
          ]),
        }),
      ),
    ).toThrow('다섯 칸');
    expect(() => parseSemasOverview(`<html><body>${QUALIFICATION}</body></html>`)).toThrow('자금 표를 찾지 못했습니다');
  });

  it('금액 하나로 적힌 한도만 원 단위로 읽는다', () => {
    expect(parseSemasSingleLimit('7천만원')).toBe('70000000');
    expect(parseSemasSingleLimit('1억원')).toBe('100000000');
    expect(parseSemasSingleLimit('5 억원')).toBe('500000000');
    expect(parseSemasSingleLimit('1억 4백만원')).toBe('104000000');
    expect(parseSemasSingleLimit('(운전) 1억원 (시설) 5억원')).toBeNull();
    expect(parseSemasSingleLimit('(일반형) 7천만원 (희망형) 1억원')).toBeNull();
    expect(parseSemasSingleLimit('원')).toBeNull();
    expect(parseSemasSingleLimit('')).toBeNull();
  });
});

describe('홈 화면 접수 표시와 공지', () => {
  it('대출 카드만 읽고 상환연장 카드는 뺀다', () => {
    expect(parseSemasHomeCards(homeHtml())).toEqual([
      {
        section: '대리대출',
        name: '소상공인 대환대출',
        status: '접수중',
        periodText: '접수기간 : 2026-01-05 ~ 자금소진시까지',
      },
      {
        section: '대리대출',
        name: '소공인특화자금',
        status: '접수중',
        periodText: '접수기간 : 2026-01-05 ~ 자금소진시까지',
      },
      {
        section: '직접대출',
        name: '일시적경영애로자금(홈플러스 피해 소상공인)',
        status: '접수중',
        periodText: '접수기간 : 2026-07-15 ~ 자금소진시까지',
      },
      {
        section: '직접대출',
        name: '혁신성장촉진자금(사회연대경제조직)',
        status: '접수중',
        periodText: '접수기간 : 2026-01-12 ~ 자금소진시까지',
      },
    ]);
    // 접수 중인 자금이 하나도 없어도 영역이 있으면 빈 목록이다.
    expect(parseSemasHomeCards(homeHtml([]))).toEqual([]);
  });

  it("'정책자금 신청하기' 영역이 없으면 접수 상태를 확인할 수 없어 실패한다", () => {
    expect(() => parseSemasHomeCards('<html><body><div class="main">공지</div></body></html>')).toThrow(
      '정책자금 신청하기',
    );
    expect(() =>
      parseSemasHomeCards(homeHtml(['<div class="jd_loan"><p class="jd_title"><span>직접대출</span></p></div>'])),
    ).toThrow('자금명이나 접수 상태');
  });

  it('공지 목록 JSON을 읽고, 형식이 깨진 항목은 세기만 한다', () => {
    const page = parseSemasNoticePage(
      JSON.stringify({
        result: [
          listItem(404, '대리대출', '2026년 4분기 일반경영안정자금(대리대출) 접수 안내', { bbsTypeCd: 1 }),
          { bltwtrSeq: 'x' },
          listItem(300, '직접대출', '&lt;안내&gt; 2026년 공지'),
        ],
        pagination: { vTotalPage: 8, totalCount: 78 },
      }),
    );
    expect(page).toMatchObject({ totalPages: 8, totalCount: 78, malformed: 1 });
    expect(page.notices.map((notice) => [notice.seq, notice.bbsTypeCd, notice.title])).toEqual([
      [404, '01', '2026년 4분기 일반경영안정자금(대리대출) 접수 안내'],
      [300, '01', '<안내> 2026년 공지'],
    ]);
    expect(() => parseSemasNoticePage('<html>오류</html>')).toThrow('JSON이 아닙니다');
    expect(() => parseSemasNoticePage(JSON.stringify({ result: [] }))).toThrow('pagination');
  });

  it('공지 상세에서 접수기간·신청대상·제외 문장을 읽는다', () => {
    expect(parseSemasNoticeDetail(DETAILS[404])).toEqual({
      title: '2026년 4분기 일반경영안정자금(대리대출) 접수 안내',
      periodText: '2026. 10. 6.(화) 10:00 ~ 예산소진 시까지',
      target: '업력 무관 소상공인',
      exclusionLines: [],
    });
    expect(parseSemasNoticeDetail(DETAILS[402])).toMatchObject({
      periodText: '2026년 9월 7일 (월) 10:00 ~ 예산 소진 시까지',
      target: expect.stringContaining('의 지원대상은 연매출 1억 4백만원 미만'),
    });
    expect(parseSemasNoticeDetail(DETAILS[396]).periodText).toBe('‘26. 8. 10.(월), 10:00 ~ 18:00');
    // '지원대상은' 뒤에서 줄이 바뀌면 다음 줄까지 잇는다.
    const wrapped = detailHtml('2026년 8월 신용취약소상공인자금 신청안내', [
      '신용취약소상공인자금의 지원대상은',
      '신용관리교육을 사전 이수한 업력 90일 이상의 중·저신용(NCB 839점 이하) 소상공인입니다.',
    ]);
    expect(parseSemasNoticeDetail(wrapped).target).toBe(
      '신용취약소상공인자금의 지원대상은 신용관리교육을 사전 이수한 업력 90일 이상의 중·저신용(NCB 839점 이하) 소상공인입니다.',
    );
    // 본문 안에 div가 중첩되어도 본문 끝을 제대로 찾는다.
    const nested = detailHtml('공지', [
      '□ 접수기간 : 2026. 1. 5.(월) 10:00 ~ 예산소진 시까지',
      '<div>□ 제외대상 : 유흥주점업</div>',
    ]);
    expect(parseSemasNoticeDetail(nested).exclusionLines).toEqual(['□ 제외대상 : 유흥주점업']);
    expect(() => parseSemasNoticeDetail('<html><body>세션이 만료되었습니다</body></html>')).toThrow('제목이나 본문');
  });

  it('자금의 접수·신청 안내 공지 중 가장 최근 것을 고른다', () => {
    const overview = parseSemasOverview(overviewHtml());
    const notices = parseSemasNoticePage(listPage(LIST_ITEMS, 1, 100)).notices;
    const selected = selectSemasFundNotices(overview.rows, notices);
    expect(Object.fromEntries([...selected].map(([key, notice]) => [key, notice.seq]))).toEqual({
      '직접대출:혁신성장촉진자금': 396,
      '직접대출:일시적경영애로자금': 402,
      '대리대출:일반경영안정자금': 404,
      '대리대출:소공인특화자금': 326,
      '대리대출:대환대출': 325,
    });
    const row = { section: '직접대출' as const, name: '신용취약소상공인자금' };
    const notice = (title: string, section = '직접대출', category = '대출정보'): SemasNotice => ({
      seq: 1,
      bbsTypeCd: '01',
      section,
      category,
      title,
      registeredOn: '2026-08-14',
    });
    expect(isSemasFundNotice(row, notice('2026년 8월 신용취약소상공인자금 신청안내'))).toBe(true);
    expect(isSemasFundNotice(row, notice('신용취약소상공인자금 금리인하제도 신청안내'))).toBe(false);
    expect(isSemasFundNotice(row, notice('2026년 신용취약소상공인자금 사전 이수 교육 안내'))).toBe(false);
    expect(isSemasFundNotice(row, notice('2026년 8월 신용취약소상공인자금 신청안내', '대리대출'))).toBe(false);
    expect(isSemasFundNotice(row, notice('2026년 8월 신용취약소상공인자금 신청안내', '직접대출', '기타'))).toBe(false);
  });
});

describe('소진공 자금을 카탈로그 상품으로 바꾸기', () => {
  it('접수중 카드와 공지가 맞는 자금은 OPEN이고, 금리·상환 조건을 추측하지 않는다', () => {
    const { byName } = mapDefault();
    const product = byName.get('소공인특화자금(대리대출)');
    expect(product).toMatchObject({
      productKey: semasFundProductKey({ section: '대리대출', name: '소공인특화자금' }),
      organization: '소상공인시장진흥공단',
      supportType: 'LOAN',
      eligibleBusinessStages: ['POST_REGISTRATION'],
      region: { scope: 'NATIONWIDE', districtCodes: [], note: null },
      purpose: { included: [], excluded: [] },
      industryConditions: { scope: 'UNKNOWN', included: [], excluded: [] },
      applicationPeriod: { start: '2026-01-05', end: null, note: '2026-01-05 ~ 자금소진시까지' },
      observedApplicationStatus: 'OPEN',
      observedAt: AS_OF,
      reviewedAt: AS_OF,
      nextReviewAt: null,
      officialUrl: 'https://ols.semas.or.kr/ols/man/SMAN052M/page.do?bltwtrSeq=326&bbsTypeCd=01',
      sourceDocumentRetrieved: false,
      sourceChecksum: null,
      publicLimit: null,
      interestCondition: '대출금리 기준금리+0.6%P (`26년 3/4 분기 정책자금 기준금리 : 3.85%)',
      interestRateConfirmed: false,
      interestRatePercent: null,
      repaymentCondition: '대출기간 (운전) 5년(거치 2년) (시설) 8년(거치 3년)',
      repaymentMethod: 'UNKNOWN',
      repaymentTermMonths: null,
      repaymentGraceMonths: null,
      sourceRef: { source: 'SEMAS_OLS', externalId: '대리대출:소공인특화자금' },
    });
    expect(product?.unsupportedCalculationReasons[0]).toContain('기준금리에 연동');
    expect(product?.additionalChecks[0]).toBe('신청대상(공지): 제조업을 영위하는 상시근로자수 10인 미만 소공인');
    // 근거마다 그 근거를 읽은 페이지 응답의 checksum을 남긴다(ADR 0006 2절).
    const overviewChecksum = sha256(overviewHtml());
    const homeChecksum = sha256(homeHtml());
    expect(product?.evidence.map((entry) => [entry.id, entry.subject, entry.retrievalMethod, entry.checksum])).toEqual([
      ['semas-identity', 'IDENTITY', 'OFFICIAL_WEB_PAGE', overviewChecksum],
      ['semas-financial', 'FINANCIAL_CONDITION', 'OFFICIAL_WEB_PAGE', overviewChecksum],
      ['semas-stage', 'BUSINESS_STAGE', 'OFFICIAL_WEB_PAGE', overviewChecksum],
      ['semas-region', 'REGION', 'OFFICIAL_WEB_PAGE', overviewChecksum],
      ['semas-eligibility', 'ELIGIBILITY_CONDITION', 'OFFICIAL_WEB_PAGE', overviewChecksum],
      ['semas-period-home', 'APPLICATION_PERIOD', 'OFFICIAL_WEB_PAGE', homeChecksum],
      ['semas-period-notice', 'APPLICATION_PERIOD', 'OFFICIAL_WEB_PAGE', sha256(DETAILS[326])],
    ]);
    // '소상공인 대환대출' 카드는 표의 '대환대출'과 같은 자금이다.
    expect(byName.get('대환대출(대리대출)')).toMatchObject({
      observedApplicationStatus: 'OPEN',
      publicLimit: '50000000',
    });
  });

  it('만든 상품은 카탈로그 검사를 통과하고, 예비 창업자에게는 사업자등록 이후 후보다', () => {
    const { mapping } = mapDefault();
    const versions = mapping.products.map((product) => ({ ...product, version: '1.0.0', reviewer: AUTO_REVIEWER }));
    const validation = validateFundingCatalog(catalogWith(versions), { asOfDate: AS_OF });
    expect(validation.issues).toEqual([]);
    const catalog = validation.catalog;
    if (catalog === null) throw new Error('카탈로그 검증에 실패했습니다.');
    const product = catalog.products.find((entry) => entry.name === '소공인특화자금(대리대출)');
    if (product === undefined) throw new Error('상품이 없습니다.');
    const preFounder = evaluateProduct(
      product,
      { ...POST_REGISTRATION_PROFILE, businessStage: 'PRE_REGISTRATION' },
      { asOfDate: AS_OF, automation: catalog.automation },
    );
    expect(preFounder.candidateStatus).toBe('POST_REGISTRATION');
    expect(preFounder.branch).toBe('POLICY_FUND');
    expect(preFounder.automation).toMatchObject({ source: 'SEMAS_OLS', lastSucceededOn: AS_OF });
  });

  it('정책자금 자동 승격이 꺼져 있으면 추가 확인이고, 켜면 접수 중인 자금만 현재 후보가 된다', () => {
    const { mapping } = mapDefault();
    const versions = mapping.products.map((product) => ({ ...product, version: '1.0.0', reviewer: AUTO_REVIEWER }));
    for (const promotion of [false, true]) {
      const validation = validateFundingCatalog(
        catalogWith(versions, { policyLoanPromotion: promotion, repaymentPromotion: promotion }),
        { asOfDate: AS_OF },
      );
      const catalog = validation.catalog;
      if (catalog === null) throw new Error('카탈로그 검증에 실패했습니다.');
      const statuses = Object.fromEntries(
        catalog.products.map((product) => {
          const evaluation = evaluateProduct(product, POST_REGISTRATION_PROFILE, {
            asOfDate: AS_OF,
            automation: catalog.automation,
          });
          // 변동·모호한 금리와 상환방식이 없어 스위치를 켜도 상환 계산 대상이 아니다.
          expect(evaluation.repayment.supported).toBe(false);
          return [product.name, evaluation.candidateStatus];
        }),
      );
      expect(statuses).toEqual({
        // 최근 공지의 하루 접수(8. 10.)가 끝났다. 세부 유형 접수는 확인 항목에 남는다.
        '혁신성장촉진자금(직접대출)': 'CLOSED',
        '일시적경영애로자금(직접대출)': 'NEEDS_CONFIRMATION',
        '일반경영안정자금(대리대출)': 'NEEDS_CONFIRMATION',
        '소공인특화자금(대리대출)': promotion ? 'CURRENT_CANDIDATE' : 'NEEDS_CONFIRMATION',
        '장애인기업지원자금(대리대출)': 'NEEDS_CONFIRMATION',
        '대환대출(대리대출)': promotion ? 'CURRENT_CANDIDATE' : 'NEEDS_CONFIRMATION',
      });
    }
    // 출처 확인이 3일 넘게 끊기면 스위치를 켜도 현재 후보에서 빠진다.
    const stale = validateFundingCatalog(
      catalogWith(versions, {
        policyLoanPromotion: true,
        sourceSyncs: [{ ...FRESH_SYNC, lastSucceededOn: '2026-09-25' }],
      }),
      { asOfDate: AS_OF },
    ).catalog;
    if (stale === null) throw new Error('카탈로그 검증에 실패했습니다.');
    const evaluation = evaluateProduct(stale.products[3], POST_REGISTRATION_PROFILE, {
      asOfDate: AS_OF,
      automation: stale.automation,
    });
    expect(evaluation.candidateStatus).toBe('REVIEW_OVERDUE');
  });

  it("'고정금리(2.0%P)'처럼 모호한 금리와 여러 금액이 적힌 한도는 확정 값으로 옮기지 않는다", () => {
    const { byName } = mapDefault();
    const disabled = byName.get('장애인기업지원자금(대리대출)');
    expect(disabled).toMatchObject({
      interestRateConfirmed: false,
      interestRatePercent: null,
      publicLimit: '100000000',
    });
    expect(disabled?.unsupportedCalculationReasons[0]).toContain('연 금리인지 가산폭인지 모호');
    expect(byName.get('혁신성장촉진자금(직접대출)')?.publicLimit).toBeNull();
  });

  it('세부 유형 카드만 있으면 자금 전체를 접수 중으로 보지 않고 확인 항목에 적는다', () => {
    const { byName } = mapDefault();
    const innovation = byName.get('혁신성장촉진자금(직접대출)');
    expect(innovation?.observedApplicationStatus).toBe('UNKNOWN');
    expect(innovation?.additionalChecks).toContain(
      '현재 접수 중으로 표시된 세부 유형: 혁신성장촉진자금(사회연대경제조직) (접수중, 접수기간 : 2026-01-12 ~ 자금소진시까지)',
    );
    // 하루 접수 공지가 끝났으면 그 기간을 남겨 판정이 접수 종료로 본다.
    expect(innovation?.applicationPeriod).toEqual({ start: '2026-08-10', end: '2026-08-10', note: null });
    const hardship = byName.get('일시적경영애로자금(직접대출)');
    expect(hardship?.observedApplicationStatus).toBe('UNKNOWN');
    expect(hardship?.additionalChecks.join('\n')).toContain('홈플러스 피해 소상공인');
    expect(hardship?.additionalChecks.join('\n')).toContain("'정책자금 신청하기'에 이 자금의 접수 표시가 없습니다");
  });

  it('접수 시작 전인 공고와 공지를 찾지 못한 자금은 접수 중이 아니다', () => {
    const { byName } = mapDefault();
    expect(byName.get('일반경영안정자금(대리대출)')).toMatchObject({
      observedApplicationStatus: 'UNKNOWN',
      applicationPeriod: { start: '2026-10-06', end: null, note: '2026. 10. 6.(화) 10:00 ~ 예산소진 시까지' },
      officialUrl: 'https://ols.semas.or.kr/ols/man/SMAN052M/page.do?bltwtrSeq=404&bbsTypeCd=01',
    });
    const disabled = byName.get('장애인기업지원자금(대리대출)');
    expect(disabled).toMatchObject({
      observedApplicationStatus: 'UNKNOWN',
      applicationPeriod: { start: null, end: null },
      officialUrl: SEMAS_OLS_URLS.overview,
    });
    expect(disabled?.evidence.find((entry) => entry.subject === 'APPLICATION_PERIOD')?.summary).toContain(
      '접수 안내 공지도 찾지 못했습니다',
    );
  });

  it('홈 화면 표시가 공지·기준일과 모순되면 접수 중으로 기록하지 않는다', () => {
    // 카드 시작일이 공지 시작일과 다르다.
    const mismatch = mapDefault({
      cards: [card('dd', '소공인특화자금', '접수기간 : 2026-02-02 ~ 자금소진시까지')],
    }).byName.get('소공인특화자금(대리대출)');
    expect(mismatch?.observedApplicationStatus).toBe('UNKNOWN');
    expect(mismatch?.additionalChecks).toContain(
      '홈 화면 접수 시작일 2026-02-02과 공지 접수 시작일 2026-01-05이 다릅니다.',
    );

    // 접수중이라고 표시했지만 시작일이 기준일 이후다.
    const early = mapDefault({
      cards: [card('dd', '일반경영안정자금', '접수기간 : 2026-10-06 ~ 자금소진시까지')],
    }).byName.get('일반경영안정자금(대리대출)');
    expect(early?.observedApplicationStatus).toBe('UNKNOWN');

    // 접수중이라고 표시했지만 종료일이 이미 지났다.
    const ended = mapDefault({
      cards: [card('jd', '일시적경영애로자금', '접수기간 : 2026-09-07 ~ 2026-09-28')],
    }).byName.get('일시적경영애로자금(직접대출)');
    expect(ended?.observedApplicationStatus).toBe('UNKNOWN');
    expect(ended?.additionalChecks).toContain(
      '홈 화면은 접수중이지만 접수 종료일 2026-09-28이 기준일 2026-09-29 이전입니다.',
    );

    // 홈 화면은 '자금소진시까지'인데 공지에 종료일이 있으면 더 좁은 공지 종료일을 쓴다.
    const overview = parseSemasOverview(overviewHtml());
    const noticeWithEnd: SemasFundNotice = {
      checksum: 'd'.repeat(64),
      notice: {
        seq: 330,
        bbsTypeCd: '01',
        section: '대리대출',
        category: '대출정보',
        title: '공지',
        registeredOn: AS_OF,
      },
      detail: {
        title: '2026년 소공인특화자금(대리대출) 접수 안내',
        periodText: '2026. 1. 5.(월) 10:00 ~ 2026. 10. 30.(금) 18:00',
        target: null,
        exclusionLines: [],
      },
    };
    const narrowed = mapSemasFunds(
      {
        overview,
        cards: parseSemasHomeCards(homeHtml([card('dd', '소공인특화자금', '접수기간 : 2026-01-05 ~ 자금소진시까지')])),
        notices: new Map([['대리대출:소공인특화자금', noticeWithEnd]]),
        pageChecksums: { overview: 'a'.repeat(64), home: 'b'.repeat(64) },
      },
      { asOfDate: AS_OF },
    ).products.find((product) => product.name === '소공인특화자금(대리대출)');
    expect(narrowed).toMatchObject({
      observedApplicationStatus: 'OPEN',
      applicationPeriod: { start: '2026-01-05', end: '2026-10-30', note: null },
    });

    // 접수 마감 표시는 CLOSED, 알 수 없는 표시는 UNKNOWN이다.
    const closed = mapDefault({
      cards: [card('dd', '소공인특화자금', '접수기간 : 2026-01-05 ~ 자금소진시까지', '접수마감')],
    }).byName.get('소공인특화자금(대리대출)');
    expect(closed?.observedApplicationStatus).toBe('CLOSED');
    const planned = mapDefault({
      cards: [card('dd', '소공인특화자금', '접수기간 : 2026-01-05 ~ 자금소진시까지', '접수예정')],
    }).byName.get('소공인특화자금(대리대출)');
    expect(planned?.observedApplicationStatus).toBe('UNKNOWN');

    // 날짜 없는 '상시접수'는 출처가 접수중으로 표시할 때만 인정한다.
    const always = mapDefault({ cards: [card('dd', '장애인기업지원자금', '상시접수')] }).byName.get(
      '장애인기업지원자금(대리대출)',
    );
    expect(always).toMatchObject({
      observedApplicationStatus: 'OPEN',
      applicationPeriod: { start: null, end: null, note: '상시접수' },
    });
  });

  it('제외 업종에 음식점 관련 표현이 보이면 접수 중으로 올리지 않고 확인 항목에 남긴다', () => {
    const qualification = QUALIFICATION.replace('부동산업 등', '부동산업, 일반음식점업 등');
    const { byName } = mapDefault({ overview: overviewHtml({ qualification }) });
    const product = byName.get('소공인특화자금(대리대출)');
    expect(product?.observedApplicationStatus).toBe('UNKNOWN');
    expect(product?.additionalChecks.join('\n')).toContain(
      "제외 신호: '제외업종: 유흥 향락 업종, 전문업종, 금융업, 보험업, 부동산업, 일반음식점업 등'",
    );
  });

  it('출처 식별자와 상품 키는 대출구분과 자금명으로 정해지고, 표의 중복 행과 표에 없는 카드는 따로 센다', () => {
    expect(semasFundExternalId({ section: '대리대출', name: '긴급경영안정자금 (일시적 경영애로)' })).toBe(
      '대리대출:긴급경영안정자금(일시적경영애로)',
    );
    expect(semasFundProductKey({ section: '대리대출', name: '소상공인 대환대출' })).toBe(
      semasFundProductKey({ section: '대리대출', name: '대환대출' }),
    );
    expect(semasFundProductKey({ section: '직접대출', name: '대환대출' })).toMatch(/^semas-ols-direct-[0-9a-f]{10}$/);
    expect(semasNoticeUrl({ seq: 404, bbsTypeCd: '01' })).toBe(
      'https://ols.semas.or.kr/ols/man/SMAN052M/page.do?bltwtrSeq=404&bbsTypeCd=01',
    );

    const agency = fundTable('2026년 정책자금 대리대출 세부 지원요건', [...AGENCY_ROWS, AGENCY_ROWS[0]]);
    const { mapping } = mapDefault({
      overview: overviewHtml({ agency }),
      cards: [...HOME_CARDS, card('dd', '신규특별자금', '접수기간 : 2026-09-01 ~ 자금소진시까지')],
    });
    expect(mapping.duplicateRows).toBe(1);
    expect(mapping.products).toHaveLength(6);
    expect(mapping.unmatchedCards).toEqual(["대리대출 '신규특별자금' (접수중)"]);
  });
});

describe('소진공 정책자금 수집기', () => {
  it('robots.txt 확인 뒤 표·홈 화면·공지 목록·공지 상세를 차례로 읽고, 요청마다 1초 이상 쉰다', async () => {
    const { promise, calls, sleeps, logs } = collect();
    const result = await promise;
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)).toEqual([
      'GET /robots.txt',
      'GET /ols/man/SMAN018M/page.do',
      'GET /ols/man/SMAN010M/page.do',
      'POST /ols/man/SMAN051M/search.do',
      'POST /ols/man/SMAN051M/search.do',
      'GET /ols/man/SMAN052M/page.do?bltwtrSeq=396&bbsTypeCd=01',
      'GET /ols/man/SMAN052M/page.do?bltwtrSeq=402&bbsTypeCd=01',
      'GET /ols/man/SMAN052M/page.do?bltwtrSeq=404&bbsTypeCd=01',
      'GET /ols/man/SMAN052M/page.do?bltwtrSeq=326&bbsTypeCd=01',
      'GET /ols/man/SMAN052M/page.do?bltwtrSeq=325&bbsTypeCd=01',
    ]);
    expect(calls.every((call) => call.headers['User-Agent'] === semasUserAgent(CONTACT))).toBe(true);
    expect(semasUserAgent(CONTACT)).toBe('TrendBench-funding-sync/1.0 (+ops@example.com)');
    expect(new URLSearchParams(calls[3].body).get('pageNo')).toBe('1');
    expect(new URLSearchParams(calls[4].body).get('pageNo')).toBe('2');
    expect(sleeps).toHaveLength(calls.length - 1);
    expect(sleeps.every((ms) => ms >= SEMAS_OLS_MIN_REQUEST_INTERVAL_MS)).toBe(true);
    expect(result.fetchedCount).toBe(6);
    expect(result.products).toHaveLength(6);
    expect(result.responseChecksum).toMatch(/^[0-9a-f]{64}$/);
    // 근거 checksum은 수집기가 실제로 받은 응답 본문의 SHA-256이다.
    const special = result.products.find((product) => product.name === '소공인특화자금(대리대출)');
    expect(special?.evidence.find((entry) => entry.id === 'semas-identity')?.checksum).toBe(sha256(overviewHtml()));
    expect(special?.evidence.find((entry) => entry.id === 'semas-period-home')?.checksum).toBe(sha256(homeHtml()));
    expect(special?.evidence.find((entry) => entry.id === 'semas-period-notice')?.checksum).toBe(sha256(DETAILS[326]));
    expect(logs.join('\n')).toContain('자금 6건으로 상품 6건');
    expect(logs.join('\n')).toContain('접수 중 2건');
  });

  it('요청 간격 옵션은 1초보다 짧게 줄일 수 없다', async () => {
    const { fetchImpl } = siteFetch();
    const sleeps: number[] = [];
    const adapter = createSemasOlsAdapter({
      contact: CONTACT,
      fetchImpl,
      requestIntervalMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await adapter.collect({ asOfDate: AS_OF, log: () => {} });
    expect(Math.min(...sleeps)).toBe(SEMAS_OLS_MIN_REQUEST_INTERVAL_MS);
  });

  it('운영자 연락처가 없거나 헤더에 쓸 수 없으면 요청하지 않는다', async () => {
    for (const contact of [undefined, '  ', '운영자 메일']) {
      const { promise, calls } = collect({}, { contact });
      await expect(promise).rejects.toThrow('FUNDING_SYNC_CONTACT');
      expect(calls).toHaveLength(0);
    }
  });

  it('robots.txt가 생기면 다른 페이지를 읽지 않고 멈춘다', async () => {
    const { promise, calls } = collect({ robots: () => ({ status: 200, body: 'User-agent: *\nDisallow: /ols/' }) });
    await expect(promise).rejects.toThrow('robots.txt가 생겼습니다');
    expect(calls).toHaveLength(1);
  });

  it('403·429·자동 입력 방지 화면은 다시 시도하지 않고 멈춘다', async () => {
    for (const reply of [
      { status: 403, body: 'Forbidden' },
      { status: 429, body: 'Too Many Requests' },
      { status: 200, body: '<html>자동입력 방지 문자를 입력하세요</html>' },
    ]) {
      const { promise, calls } = collect({ overview: () => reply });
      await expect(promise).rejects.toThrow('멈춥니다');
      expect(calls).toHaveLength(2);
    }
  });

  it('서버 오류와 연결 오류는 두 번까지 다시 시도한다', async () => {
    const replies: Reply[] = [{ status: 503, body: '' }, new TypeError('fetch failed')];
    const recovered = collect({ home: () => replies.shift() ?? { status: 200, body: homeHtml() } });
    await expect(recovered.promise).resolves.toMatchObject({ fetchedCount: 6 });
    expect(recovered.calls.filter((call) => call.url === SEMAS_OLS_URLS.home)).toHaveLength(3);

    const failed = collect({ home: () => ({ status: 500, body: '' }) });
    await expect(failed.promise).rejects.toThrow('3번 실패');
    expect(failed.calls.filter((call) => call.url === SEMAS_OLS_URLS.home)).toHaveLength(3);
  });

  it('페이지 형식이 바뀌어 필수 항목을 찾지 못하면 실패한다', async () => {
    const noTable = collect({ overview: () => ({ status: 200, body: `<html>${QUALIFICATION}</html>` }) });
    await expect(noTable.promise).rejects.toThrow('자금 표를 찾지 못했습니다');

    const noHome = collect({ home: () => ({ status: 200, body: '<html><body>점검 중입니다</body></html>' }) });
    await expect(noHome.promise).rejects.toThrow('정책자금 신청하기');

    const badDetail = collect({ detail: () => ({ status: 200, body: detailHtml('다른 공지', ['본문']) }) });
    await expect(badDetail.promise).rejects.toThrow('목록 제목');

    const missingDetail = collect({ detail: () => ({ status: 404, body: '' }) });
    await expect(missingDetail.promise).rejects.toThrow('HTTP 404');
  });

  it('공지 목록이 비거나 전체 건수보다 적게 오면 실패한다', async () => {
    const empty = collect({
      list: (pageNo) => ({ status: 201, body: pageNo === 1 ? listPage(LIST_ITEMS, 1) : listPage([], 1, 10, 11) }),
    });
    await expect(empty.promise).rejects.toThrow('2쪽이 비어 있습니다');

    const truncated = collect({ list: (pageNo) => ({ status: 201, body: listPage(LIST_ITEMS, pageNo, 10, 12) }) });
    await expect(truncated.promise).rejects.toThrow('전체 12건 중 11건');

    const notJson = collect({ list: () => ({ status: 200, body: '<html>세션 만료</html>' }) });
    await expect(notJson.promise).rejects.toThrow('JSON이 아닙니다');
  });
});
