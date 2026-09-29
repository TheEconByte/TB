import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CollectedFundingProduct, FundingSourceAdapter, FundingSourceCollection } from '../sync.ts';
import { compareIsoDates, isRealDate } from '../types.ts';

// 소상공인시장진흥공단 정책자금 사이트(ols.semas.or.kr)의 정책자금 수집기(ADR 0006 1·3절).
// 로그인 없이 공개된 서버 HTML과, 공지 상세를 찾는 데만 쓰는 공지 목록 JSON을 읽는다.
// - 정책자금 한눈에 보기: 자금별 신청요건·대출기간·한도·금리, 공통 지원자격, 기준금리
// - 홈 화면 "정책자금 신청하기": 자금별 접수 상태("접수중")와 접수기간
// - 공지사항 목록(JSON): 자금별 최신 접수 안내 공지를 찾는 데만 쓴다
// - 공지 상세: 접수기간·신청대상 문장
// 첨부(PDF)는 읽지 않고, 페이지 원문은 저장하지 않는다. 뽑은 값과 주소, 응답 checksum만 남긴다.
export const SEMAS_OLS_ORIGIN = 'https://ols.semas.or.kr';
export const SEMAS_OLS_URLS = {
  robots: `${SEMAS_OLS_ORIGIN}/robots.txt`,
  home: `${SEMAS_OLS_ORIGIN}/ols/man/SMAN010M/page.do`,
  overview: `${SEMAS_OLS_ORIGIN}/ols/man/SMAN018M/page.do`,
  noticeList: `${SEMAS_OLS_ORIGIN}/ols/man/SMAN051M/search.do`,
  noticeDetail: `${SEMAS_OLS_ORIGIN}/ols/man/SMAN052M/page.do`,
} as const;

// 요청 사이 최소 간격(ADR 0006 3절: 1초 이상). 옵션으로 더 줄일 수 없다.
export const SEMAS_OLS_MIN_REQUEST_INTERVAL_MS = 1000;
// 공지 목록은 이 쪽수까지만 읽는다(한 쪽 10건). 그보다 오래된 공지는 현재 접수 안내가 아니다.
export const SEMAS_OLS_MAX_NOTICE_PAGES = 30;

const ORGANIZATION = '소상공인시장진흥공단';
const OVERVIEW_DOCUMENT = '소진공 정책자금 한눈에 보기';
const HOME_DOCUMENT = '소진공 정책자금 사이트 홈 화면 · 정책자금 신청하기';
const OVERVIEW_COLUMNS: readonly string[] = ['자금명', '신청요건', '대출기간', '대출한도', '대출금리'];

// 정상 페이지에는 없는 차단 신호. 만나면 우회하지 않고 멈춘다(ADR 0006 3절).
const BLOCK_PAGE_PATTERN = /captcha|자동\s*입력\s*방지|보안\s*문자/i;

// 제외 업종·제외 대상 문장에 이 제품의 업종(음식점·카페)이 들어 있는지 보는 신호. 유흥주점 같은
// 표현이 음식점 전체를 막지는 않으므로 '주점'은 넣지 않는다. 이 신호는 올리는 데 쓰지 않고 내리는 데만 쓴다.
const FOOD_EXCLUSION_PATTERN = /음식|외식|식당|요식|카페|커피|제과|베이커리/;

export type SemasLoanSection = '직접대출' | '대리대출';
const LOAN_SECTIONS: readonly SemasLoanSection[] = ['직접대출', '대리대출'];

export type SemasFundRow = {
  section: SemasLoanSection;
  // 표 위 제목(예: '2026년 정책자금 직접대출 세부 지원요건').
  heading: string;
  name: string;
  requirement: string;
  term: string;
  limit: string;
  rate: string;
};

export type SemasOverview = {
  rows: SemasFundRow[];
  // 공통 지원자격 항목.
  qualification: string[];
  // 공통 지원자격의 '제외업종: …' 항목. 없으면 null이다.
  excludedIndustries: string | null;
  // 금리 안내사항의 분기 기준금리 문장. 없으면 null이다.
  baseRate: string | null;
};

// 홈 화면 "정책자금 신청하기"의 대출 카드 하나.
export type SemasHomeCard = {
  section: SemasLoanSection;
  name: string;
  // 카드의 상태 표시(예: '접수중').
  status: string;
  // 카드의 접수기간 표시(예: '접수기간 : 2026-01-05 ~ 자금소진시까지').
  periodText: string;
};

export type SemasNotice = {
  seq: number;
  bbsTypeCd: string;
  // 대출구분(직접대출·대리대출).
  section: string;
  // 게시 구분(대출정보·서비스안내·기타).
  category: string;
  title: string;
  registeredOn: string;
};

export type SemasNoticeDetail = {
  title: string;
  // '□ 접수기간 : …' 문장의 값. 없으면 null이다.
  periodText: string | null;
  // '□ 신청대상 : …' 또는 '…의 지원대상은 …' 문장. 없으면 null이다.
  target: string | null;
  // '제외'가 들어간 본문 줄.
  exclusionLines: string[];
};

export type SemasPeriod = {
  start: string;
  // 종료일. '예산 소진 시까지'처럼 날짜가 없으면 null이다.
  end: string | null;
  // 종료일이 없을 때 원문 표기.
  openEndedNote: string | null;
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// 태그를 걷어 내고 줄바꿈(<br>, 문단·목록 끝)을 줄 단위로 남긴다.
function htmlToLines(html: string): string[] {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|div|tr|h\d)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

function htmlToText(html: string): string {
  return htmlToLines(html).join(' ');
}

function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

// 자금명 비교용. 공백을 빼고, 카드·공지에 붙는 앞머리 '소상공인'(예: '소상공인 대환대출')을 뗀다.
export function normalizeSemasFundName(value: string): string {
  return compact(value).replace(/^소상공인/, '');
}

// openTagIndex 위치의 여는 태그부터 짝이 맞는 닫는 태그까지의 안쪽 HTML. 같은 태그가 중첩되어도 짝을 센다.
function innerHtmlAt(html: string, openTagIndex: number, tag: string): string | null {
  const openEnd = html.indexOf('>', openTagIndex);
  if (openEnd < 0) return null;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  pattern.lastIndex = openEnd + 1;
  let depth = 1;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(openEnd + 1, match.index);
  }
  return null;
}

// 제목이 title인 <h3> 다음, 다음 <h3> 전까지의 첫 목록 항목들. 제목이 없으면 null이다.
function listAfterHeading(html: string, title: string): string[] | null {
  const headings = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  for (const [index, heading] of headings.entries()) {
    if (compact(htmlToText(heading[1])) !== compact(title)) continue;
    const from = heading.index + heading[0].length;
    const to = headings[index + 1]?.index ?? html.length;
    const section = html.slice(from, to);
    const listStart = section.search(/<ul\b/i);
    if (listStart < 0) return [];
    const list = innerHtmlAt(section, listStart, 'ul') ?? '';
    return [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((item) => htmlToText(item[1])).filter(Boolean);
  }
  return null;
}

// 정책자금 한눈에 보기. 표 머리글·섹션 제목·공통 지원자격이 예상과 다르면 파서가 필수 항목을 찾지
// 못한 것으로 보고 오류를 던진다. 그 출처는 실패로 기록된다(ADR 0006 2절).
export function parseSemasOverview(html: string): SemasOverview {
  const qualification = listAfterHeading(html, '공통 지원자격');
  // 사업 단계(사업자등록 이후)는 공통 지원자격의 소상공인 문장에서 정한다. 없으면 필수 항목 누락이다.
  if (qualification === null || !qualification.some((item) => item.includes('소상공인'))) {
    throw new Error('정책자금 한눈에 보기의 공통 지원자격에서 소상공인 대상 문장을 찾지 못했습니다.');
  }
  const excludedIndustries = qualification.find((item) => /^제외\s*업종/.test(item)) ?? null;
  const rateNotes = listAfterHeading(html, '금리 안내사항') ?? [];
  const baseRate = rateNotes.find((item) => /기준금리\s*[:：]?\s*\d+(?:\.\d+)?\s*%/.test(item)) ?? null;

  const rows: SemasFundRow[] = [];
  const headings = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  for (const [index, match] of headings.entries()) {
    const heading = htmlToText(match[1]);
    const from = match.index + match[0].length;
    const to = headings[index + 1]?.index ?? html.length;
    const section = html.slice(from, to);
    const tableStart = section.search(/<table\b/i);
    if (tableStart < 0) continue;
    const table = innerHtmlAt(section, tableStart, 'table');
    if (table === null) throw new Error(`'${heading}' 표가 닫히지 않았습니다.`);
    const columns = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((cell) => htmlToLines(cell[1])[0] ?? '');
    const isFundTable =
      columns.length === OVERVIEW_COLUMNS.length &&
      columns.every((column, position) => compact(column) === OVERVIEW_COLUMNS[position]);
    if (!isFundTable) {
      if (heading.includes('지원요건')) {
        throw new Error(`'${heading}' 표의 머리글이 예상과 다릅니다: ${columns.join(', ') || '없음'}`);
      }
      continue;
    }
    const loanSection = LOAN_SECTIONS.find((candidate) => compact(heading).includes(candidate));
    if (loanSection === undefined) {
      throw new Error(`정책자금 표 '${heading}'이(가) 직접대출인지 대리대출인지 알 수 없습니다.`);
    }
    const bodyStart = table.search(/<tbody\b/i);
    const body = bodyStart < 0 ? table : (innerHtmlAt(table, bodyStart, 'tbody') ?? '');
    for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => htmlToText(cell[1]));
      if (cells.length !== OVERVIEW_COLUMNS.length || cells[0] === '') {
        throw new Error(`'${heading}' 표의 행에서 다섯 칸(자금명·신청요건·대출기간·한도·금리)을 찾지 못했습니다.`);
      }
      const [name, requirement, term, limit, rate] = cells;
      rows.push({ section: loanSection, heading, name, requirement, term, limit, rate });
    }
  }
  if (rows.length === 0) throw new Error('정책자금 한눈에 보기에서 자금 표를 찾지 못했습니다.');
  return { rows, qualification, excludedIndustries, baseRate };
}

// 홈 화면 "정책자금 신청하기"의 대출 카드. 상환연장·조건변경 카드는 대출 상품이 아니라 뺀다.
// 영역 자체가 없으면 접수 상태를 확인할 수 없으므로 오류를 던진다.
export function parseSemasHomeCards(html: string): SemasHomeCard[] {
  const blockStart = html.search(/<div\b[^>]*class="[^"]*\bloan_wrap\b[^"]*"/i);
  const block = blockStart < 0 ? null : innerHtmlAt(html, blockStart, 'div');
  if (block === null || !/정책자금\s*(?:<\/i>)?\s*신청하기/.test(block)) {
    throw new Error("홈 화면에서 '정책자금 신청하기' 영역을 찾지 못했습니다.");
  }
  const starts = [...block.matchAll(/<div\b[^>]*class="[^"]*\b(?:jd|dd)_loan\b[^"]*"[^>]*>/gi)].map(
    (match) => match.index,
  );
  const cards: SemasHomeCard[] = [];
  for (const [index, start] of starts.entries()) {
    const card = block.slice(start, starts[index + 1] ?? block.length);
    const label = /<p\b[^>]*class="[^"]*\b[a-z]+_title\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(card);
    const section = LOAN_SECTIONS.find((candidate) => label !== null && compact(htmlToText(label[1])) === candidate);
    if (section === undefined) continue;
    const status = /<p\b[^>]*class="[^"]*\binfo_[a-z]+\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(card);
    const name = /<p\b[^>]*class="[^"]*\bloan_type\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(card);
    const period = /<p\b[^>]*class="[^"]*\bloan_date\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(card);
    const cardName = name === null ? '' : htmlToText(name[1]);
    const cardStatus = status === null ? '' : htmlToText(status[1]);
    if (cardName === '' || cardStatus === '') {
      throw new Error('홈 화면 대출 카드에서 자금명이나 접수 상태를 찾지 못했습니다.');
    }
    cards.push({
      section,
      name: cardName,
      status: cardStatus,
      periodText: period === null ? '' : htmlToText(period[1]),
    });
  }
  return cards;
}

const listText = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((value) => (value === null || value === undefined ? '' : decodeEntities(String(value)).trim()));

const noticeItemSchema = z.object({
  bltwtrSeq: z.coerce.number().int().positive(),
  bbsTypeCd: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().regex(/^\d{1,2}$/)),
  loanSeCdNm: listText,
  bltwtrClcd: listText,
  bltwtrTitNm: listText,
  frstRegDt: listText,
});

const noticePageSchema = z.object({
  result: z.array(z.unknown()),
  pagination: z.object({
    vTotalPage: z.coerce.number().int().nonnegative(),
    totalCount: z.coerce.number().int().nonnegative(),
  }),
});

export type SemasNoticePage = { notices: SemasNotice[]; totalPages: number; totalCount: number; malformed: number };

// 공지 목록 JSON 한 쪽. 공지 상세를 찾는 데만 쓰고 조건 값은 읽지 않는다(ADR 0006 3절).
export function parseSemasNoticePage(body: string): SemasNoticePage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`소진공 공지 목록 응답이 JSON이 아닙니다: ${snippet(body)}`);
  }
  const page = noticePageSchema.safeParse(parsed);
  if (!page.success) throw new Error('소진공 공지 목록 응답에 공지 목록(result)이나 쪽 정보(pagination)가 없습니다.');
  const notices: SemasNotice[] = [];
  let malformed = 0;
  for (const raw of page.data.result) {
    const item = noticeItemSchema.safeParse(raw);
    if (!item.success || item.data.bltwtrTitNm === '') {
      malformed += 1;
      continue;
    }
    notices.push({
      seq: item.data.bltwtrSeq,
      bbsTypeCd: item.data.bbsTypeCd.padStart(2, '0'),
      section: item.data.loanSeCdNm,
      category: item.data.bltwtrClcd,
      title: item.data.bltwtrTitNm.replace(/\s+/g, ' '),
      registeredOn: item.data.frstRegDt,
    });
  }
  return {
    notices,
    totalPages: page.data.pagination.vTotalPage,
    totalCount: page.data.pagination.totalCount,
    malformed,
  };
}

const PERIOD_LINE = /^[□■○◇◆▶·\-\s]*(?:접수|신청)\s*기간\s*[:：]\s*(.+)$/;
const TARGET_LINE = /^[□■○◇◆▶·\-\s]*신청\s*대상\s*[:：]\s*(.+)$/;

// 공지 상세. 제목이나 본문이 없으면 페이지 형식이 바뀐 것으로 보고 오류를 던진다.
export function parseSemasNoticeDetail(html: string): SemasNoticeDetail {
  const titleMatch = /<p\b[^>]*class="[^"]*\bview_title\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const title = titleMatch === null ? '' : htmlToText(titleMatch[1]);
  const bodyStart = html.search(/<div\b[^>]*id="cntnDiv"/i);
  const body = bodyStart < 0 ? null : innerHtmlAt(html, bodyStart, 'div');
  if (title === '' || body === null) throw new Error('소진공 공지 상세에서 제목이나 본문을 찾지 못했습니다.');
  const lines = htmlToLines(body);
  const periodText = lines.map((line) => PERIOD_LINE.exec(line)?.[1].trim()).find(Boolean) ?? null;
  // '…의 지원대상은' 뒤에서 줄이 바뀌는 공지가 있어, 그 줄이 '지원대상은'으로 끝나면 다음 줄까지 잇는다.
  const sentence = lines.findIndex((line) => line.includes('지원대상은'));
  const sentenceTarget =
    sentence < 0
      ? null
      : lines[sentence].endsWith('지원대상은') && sentence + 1 < lines.length
        ? `${lines[sentence]} ${lines[sentence + 1]}`
        : lines[sentence];
  const target = lines.map((line) => TARGET_LINE.exec(line)?.[1].trim()).find(Boolean) ?? sentenceTarget;
  return { title, periodText, target, exclusionLines: lines.filter((line) => line.includes('제외')) };
}

const DATE_TOKEN =
  /(?:(\d{4})|[‘’'`](\d{2}))\s*(?:년|[.-])\s*(\d{1,2})\s*(?:월|[.-])\s*(\d{1,2})(?!\d)\s*(?:일|\.)?|(\d{1,2})\s*(?:월|\.)\s*(\d{1,2})\s*(?:일|\.)/g;

function isoDate(year: number, month: number, day: number): string | null {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isRealDate(value) ? value : null;
}

// 소진공 접수기간 표기를 날짜로 읽는다. 읽을 수 없으면 추측하지 않고 null이다.
// - '2026. 10. 6.(화) 10:00 ~ 예산소진 시까지', '2026-01-05 ~ 자금소진시까지': 종료일 없는 접수
// - '‘26. 8. 18.(화) ~ 8. 19.(수), 10:00 ~ 18:00', '2026-01-05 ~ 2026-10-30': 시작일과 종료일
// - '‘26. 8. 10.(월), 10:00 ~ 18:00': 그날 하루
export function parseSemasPeriod(raw: string): SemasPeriod | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  const tokens = [...text.matchAll(DATE_TOKEN)];
  if (tokens.length === 0 || tokens.length > 2) return null;
  const [first, second] = tokens;
  if (first[3] === undefined) return null;
  const startYear = first[1] !== undefined ? Number(first[1]) : 2000 + Number(first[2]);
  const start = isoDate(startYear, Number(first[3]), Number(first[4]));
  if (start === null) return null;
  if (second !== undefined) {
    let end: string | null;
    if (second[3] !== undefined) {
      const endYear = second[1] !== undefined ? Number(second[1]) : 2000 + Number(second[2]);
      end = isoDate(endYear, Number(second[3]), Number(second[4]));
    } else {
      end = isoDate(startYear, Number(second[5]), Number(second[6]));
      // 연도 없이 적힌 종료일이 시작일보다 앞이면 해를 넘긴 것이다(예: 12. 28. ~ 1. 5.).
      if (end !== null && compareIsoDates(end, start) < 0)
        end = isoDate(startYear + 1, Number(second[5]), Number(second[6]));
    }
    if (end === null || compareIsoDates(end, start) < 0) return null;
    return { start, end, openEndedNote: null };
  }
  const afterStart = text.slice(first.index + first[0].length);
  const tilde = afterStart.search(/[~∼～]/);
  if (tilde < 0) return null;
  const tail = afterStart.slice(tilde + 1).trim();
  if (/^\d{1,2}:\d{2}(?:\s*까지)?[\s,.)]*$/.test(tail)) return { start, end: start, openEndedNote: null };
  if (!/\d/.test(tail) && /소진|마감|상시|까지/.test(tail)) return { start, end: null, openEndedNote: tail };
  return null;
}

function stripPeriodLabel(value: string): string {
  return value.replace(/^\s*(?:접수|신청)\s*기간\s*[:：]\s*/, '').trim();
}

// 공지 제목이 이 자금의 접수·신청 안내인지. 자금명 바로 뒤에는 (직접대출)·(대리대출)·(일반)과
// '접수 안내'·'신청안내'만 올 수 있다. '금리인하제도 신청안내'처럼 다른 제도의 안내나
// '(홈플러스 피해 소상공인)'처럼 대상을 좁힌 세부 공고는 자금 전체의 접수 안내로 보지 않는다.
export function isSemasFundNotice(row: Pick<SemasFundRow, 'section' | 'name'>, notice: SemasNotice): boolean {
  if (notice.section !== row.section || notice.category !== '대출정보') return false;
  const title = compact(notice.title);
  const fund = normalizeSemasFundName(row.name);
  for (let index = title.indexOf(fund); index >= 0; index = title.indexOf(fund, index + 1)) {
    const rest = title
      .slice(index + fund.length)
      .replace(/^(?:\((?:직접대출|대리대출|일반)\))+/, '')
      .replace(/^(?:직접대출|대리대출)/, '');
    if (/^(?:접수|신청)안내/.test(rest)) return true;
  }
  return false;
}

// 자금 하나를 가리키는 출처 식별자. 공지는 분기·월마다 새로 올라오므로 공지 번호가 아니라
// 대출구분과 자금명으로 식별한다. 차단 목록과 사람 기록 우선도 이 식별자로 맞춘다.
export function semasFundExternalId(row: Pick<SemasFundRow, 'section' | 'name'>): string {
  return `${row.section}:${normalizeSemasFundName(row.name)}`;
}

export function semasFundProductKey(row: Pick<SemasFundRow, 'section' | 'name'>): string {
  const digest = createHash('sha256').update(semasFundExternalId(row), 'utf8').digest('hex').slice(0, 10);
  return `semas-ols-${row.section === '직접대출' ? 'direct' : 'agency'}-${digest}`;
}

// 자금마다 가장 최근의 접수·신청 안내 공지를 고른다.
export function selectSemasFundNotices(
  rows: readonly SemasFundRow[],
  notices: readonly SemasNotice[],
): Map<string, SemasNotice> {
  const selected = new Map<string, SemasNotice>();
  for (const row of rows) {
    const key = semasFundExternalId(row);
    for (const notice of notices) {
      if (!isSemasFundNotice(row, notice)) continue;
      const current = selected.get(key);
      if (current === undefined || notice.seq > current.seq) selected.set(key, notice);
    }
  }
  return selected;
}

export function semasNoticeUrl(notice: Pick<SemasNotice, 'seq' | 'bbsTypeCd'>): string {
  const url = new URL(SEMAS_OLS_URLS.noticeDetail);
  url.searchParams.set('bltwtrSeq', String(notice.seq));
  url.searchParams.set('bbsTypeCd', notice.bbsTypeCd);
  return url.toString();
}

// 대출한도 칸이 금액 하나일 때만 원 단위 정수 문자열로 읽는다(예: '7천만원', '1억원', '1억 4백만원').
// 유형·용도별로 여러 금액이 적힌 칸은 공개 한도 하나로 정할 수 없어 null이다.
export function parseSemasSingleLimit(raw: string): string | null {
  const match = /^(?:(\d+)억)?(?:(?:(\d+)천)?(?:(\d+)백)?(\d+)?만)?원$/.exec(compact(raw));
  if (match === null) return null;
  const [, eok, cheon, baek, rest] = match;
  const man = BigInt(cheon ?? 0) * 1000n + BigInt(baek ?? 0) * 100n + BigInt(rest ?? 0);
  const won = BigInt(eok ?? 0) * 100_000_000n + man * 10_000n;
  return won > 0n ? won.toString() : null;
}

function rateReason(rate: string): string {
  if (/기준금리/.test(rate)) {
    return `대출금리 '${rate}'는 분기마다 바뀌는 정책자금 기준금리에 연동되어 확정 금리가 아닙니다.`;
  }
  if (/고정금리\s*\(/.test(rate)) {
    return `대출금리 표기 '${rate}'는 연 금리인지 가산폭인지 모호해 확정 금리로 보지 않습니다.`;
  }
  return `대출금리 표기 '${rate}'를 확정 연 금리로 읽지 않았습니다.`;
}

type ApplicationState = {
  status: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  period: { start: string | null; end: string | null; note: string | null };
  checks: string[];
};

// 접수 상태는 홈 화면의 명시적인 상태 표시로만 OPEN·CLOSED를 정한다(ADR 0006 4절 1번, 6절).
// 날짜가 있으면 판정 기준일과 공지 접수기간이 그 표시와 모순이 없어야 하고, 모순이 있으면 UNKNOWN이다.
function resolveApplication(
  card: SemasHomeCard | null,
  notice: { detail: SemasNoticeDetail } | null,
  asOfDate: string,
): ApplicationState {
  const noticePeriod = notice?.detail.periodText ? parseSemasPeriod(notice.detail.periodText) : null;
  const noticeText = notice?.detail.periodText ?? null;
  if (card === null) {
    return {
      status: 'UNKNOWN',
      period:
        noticePeriod === null
          ? {
              start: null,
              end: null,
              note: noticeText ?? '접수 안내 공지와 홈 화면 접수 표시에서 신청기간을 확인하지 못했습니다.',
            }
          : { start: noticePeriod.start, end: noticePeriod.end, note: noticePeriod.end === null ? noticeText : null },
      checks: [
        "소진공 홈 화면 '정책자금 신청하기'에 이 자금의 접수 표시가 없습니다. 접수 여부를 원 공고에서 확인해야 합니다.",
      ],
    };
  }

  const cardText = stripPeriodLabel(card.periodText);
  const cardPeriod = cardText === '' ? null : parseSemasPeriod(cardText);
  const checks: string[] = [];
  let start = cardPeriod?.start ?? noticePeriod?.start ?? null;
  let end = cardPeriod?.end ?? null;
  const note = cardText === '' ? noticeText : cardText;
  if (cardPeriod === null && /\d/.test(cardText)) {
    checks.push(`홈 화면 접수기간 표시 '${cardText}'를 날짜로 읽지 못했습니다.`);
  }
  if (cardPeriod !== null && noticePeriod !== null) {
    if (noticePeriod.start !== cardPeriod.start) {
      checks.push(`홈 화면 접수 시작일 ${cardPeriod.start}과 공지 접수 시작일 ${noticePeriod.start}이 다릅니다.`);
    }
    if (cardPeriod.end !== null && noticePeriod.end !== null && cardPeriod.end !== noticePeriod.end) {
      checks.push(`홈 화면 접수 종료일 ${cardPeriod.end}과 공지 접수 종료일 ${noticePeriod.end}이 다릅니다.`);
    }
  }
  // 홈 화면은 '자금소진시까지'인데 공지에 종료일이 있으면 더 좁은 공지 종료일을 쓴다.
  if (end === null && noticePeriod?.end && (cardPeriod === null || noticePeriod.start === cardPeriod.start)) {
    end = noticePeriod.end;
  }
  if (start !== null && end !== null && compareIsoDates(end, start) < 0) {
    checks.push(`접수 종료일 ${end}이 시작일 ${start}보다 앞섭니다.`);
    start = null;
    end = null;
  }
  const period = { start, end, note: end === null ? (note ?? '홈 화면과 공지에 접수 종료 표시가 없습니다.') : null };

  const status = compact(card.status);
  if (/마감|종료/.test(status)) {
    return { status: 'CLOSED', period, checks };
  }
  if (status !== '접수중') {
    checks.push(`홈 화면 접수 상태 표시가 '${card.status}'입니다. 접수 중으로 확인되지 않았습니다.`);
    return { status: 'UNKNOWN', period, checks };
  }
  if (start !== null && compareIsoDates(asOfDate, start) < 0) {
    checks.push(`홈 화면은 접수중이지만 접수 시작일 ${start}이 기준일 ${asOfDate} 이후입니다.`);
  }
  if (end !== null && compareIsoDates(end, asOfDate) < 0) {
    checks.push(`홈 화면은 접수중이지만 접수 종료일 ${end}이 기준일 ${asOfDate} 이전입니다.`);
  }
  return { status: checks.length === 0 ? 'OPEN' : 'UNKNOWN', period, checks };
}

// 공지와 그 상세, 상세 페이지 응답의 SHA-256.
export type SemasFundNotice = { notice: SemasNotice; detail: SemasNoticeDetail; checksum: string };

export type SemasMappingInput = {
  overview: SemasOverview;
  cards: readonly SemasHomeCard[];
  // 자금 식별자(semasFundExternalId)별로 고른 접수 안내 공지와 그 상세.
  notices: ReadonlyMap<string, SemasFundNotice>;
  // 정책자금 한눈에 보기와 홈 화면 응답의 SHA-256. 근거마다 그 근거를 읽은 페이지의 checksum을 남긴다(ADR 0006 2절).
  pageChecksums: { overview: string; home: string };
};

export type SemasMapping = {
  products: CollectedFundingProduct[];
  // 표에서 같은 자금이 두 번 나와 뺀 행 수.
  duplicateRows: number;
  // 표의 어느 자금과도 맞지 않는 홈 화면 대출 카드. 운영자가 새 자금을 알아채는 데 쓴다.
  unmatchedCards: string[];
};

// 정책자금 표의 자금마다 카탈로그 상품 하나를 만든다. 원문이 알려 주지 않는 용도·업종은 추측하지 않고
// 미확인으로 남기며, 금리가 기준금리 연동이거나 모호하면 확정 금리로 기록하지 않는다(ADR 0006 5절).
export function mapSemasFunds(input: SemasMappingInput, context: { asOfDate: string }): SemasMapping {
  const { overview, cards, notices, pageChecksums } = input;
  const products: CollectedFundingProduct[] = [];
  const seen = new Set<string>();
  const matchedCards = new Set<SemasHomeCard>();
  let duplicateRows = 0;
  const stageBasis = overview.qualification.find((item) => item.includes('소상공인')) ?? overview.qualification[0];
  const commonExclusions = overview.excludedIndustries === null ? [] : [overview.excludedIndustries];

  for (const row of overview.rows) {
    const externalId = semasFundExternalId(row);
    if (seen.has(externalId)) {
      duplicateRows += 1;
      continue;
    }
    seen.add(externalId);
    const fund = normalizeSemasFundName(row.name);
    const sectionCards = cards.filter((card) => card.section === row.section);
    const exactCard = sectionCards.find((card) => normalizeSemasFundName(card.name) === fund) ?? null;
    const partialCards = sectionCards.filter((card) => normalizeSemasFundName(card.name).startsWith(`${fund}(`));
    for (const card of [...(exactCard === null ? [] : [exactCard]), ...partialCards]) matchedCards.add(card);
    const notice = notices.get(externalId) ?? null;

    const application = resolveApplication(exactCard, notice, context.asOfDate);
    const exclusionSignals = [...commonExclusions, ...(notice?.detail.exclusionLines ?? [])].filter((line) =>
      FOOD_EXCLUSION_PATTERN.test(line),
    );
    if (exclusionSignals.length > 0 && application.status === 'OPEN') {
      // 제외 신호는 내리는 데만 쓴다. 접수 중으로 기록하지 않아 현재 후보가 되지 않는다(ADR 0006 4절 3번, 6절).
      application.status = 'UNKNOWN';
    }

    const noticeUrl = notice === null ? null : semasNoticeUrl(notice.notice);
    const base = { observedAt: context.asOfDate, retrievalMethod: 'OFFICIAL_WEB_PAGE' as const };
    const homeEvidence = {
      ...base,
      sourceUrl: SEMAS_OLS_URLS.home,
      sourceDocumentName: HOME_DOCUMENT,
      checksum: pageChecksums.home,
    };
    const overviewEvidence = {
      ...base,
      sourceUrl: SEMAS_OLS_URLS.overview,
      sourceDocumentName: OVERVIEW_DOCUMENT,
      checksum: pageChecksums.overview,
    };
    const evidence: CollectedFundingProduct['evidence'] = [
      {
        ...overviewEvidence,
        id: 'semas-identity',
        subject: 'IDENTITY',
        summary: `'${row.heading}' 표의 자금명 '${row.name}'(${row.section})`,
      },
      {
        ...overviewEvidence,
        id: 'semas-financial',
        subject: 'FINANCIAL_CONDITION',
        summary: `대출기간 '${row.term}', 대출한도 '${row.limit}', 대출금리 '${row.rate}'${overview.baseRate === null ? '' : `, 금리 안내 '${overview.baseRate}'`}`,
      },
      {
        ...overviewEvidence,
        id: 'semas-stage',
        subject: 'BUSINESS_STAGE',
        summary: `공통 지원자격 '${stageBasis}'. 소상공인(사업자) 대상이라 사업자등록 이후 단계로 기록했습니다.`,
      },
      {
        ...overviewEvidence,
        id: 'semas-region',
        subject: 'REGION',
        summary: '공통 지원자격에 지역 제한이 없어, 소진공 정책자금 수집 규칙에 따라 전국 대상으로 기록했습니다.',
      },
      {
        ...overviewEvidence,
        id: 'semas-eligibility',
        subject: 'ELIGIBILITY_CONDITION',
        summary: `신청요건: ${row.requirement}`,
      },
    ];
    if (exactCard !== null) {
      evidence.push({
        ...homeEvidence,
        id: 'semas-period-home',
        subject: 'APPLICATION_PERIOD',
        summary: `${exactCard.section} '${exactCard.name}' 상태 '${exactCard.status}', ${exactCard.periodText || '접수기간 표시 없음'}`,
      });
    }
    if (notice !== null && noticeUrl !== null) {
      evidence.push({
        ...base,
        id: 'semas-period-notice',
        subject: 'APPLICATION_PERIOD',
        sourceUrl: noticeUrl,
        sourceDocumentName: `소진공 정책자금 공지사항 · ${notice.detail.title}`,
        checksum: notice.checksum,
        summary: `공지 '${notice.detail.title}' 접수기간: ${notice.detail.periodText ?? '표기 없음'}`,
      });
    }
    if (exactCard === null && notice === null) {
      evidence.push({
        ...homeEvidence,
        id: 'semas-period-home',
        subject: 'APPLICATION_PERIOD',
        summary: `'정책자금 신청하기'에 ${row.section} '${row.name}' 접수 표시가 없고, 접수 안내 공지도 찾지 못했습니다.`,
      });
    }

    const additionalChecks = [
      ...(notice?.detail.target ? [`신청대상(공지): ${notice.detail.target}`] : []),
      ...partialCards.map(
        (card) =>
          `현재 접수 중으로 표시된 세부 유형: ${card.name} (${card.status}, ${card.periodText || '접수기간 표시 없음'})`,
      ),
      ...application.checks,
      ...exclusionSignals.map(
        (line) => `제외 신호: '${line}'. 음식점·카페가 제외 대상인지 원 공고에서 확인해야 합니다.`,
      ),
      '대출한도·금리·기간은 기업평가와 보증·금융기관 심사로 정해집니다. 신청안내자료(첨부)에서 확인해야 합니다.',
    ];

    products.push({
      productKey: semasFundProductKey(row),
      name: `${row.name.replace(/\s+\(/g, '(')}(${row.section})`,
      organization: ORGANIZATION,
      supportType: 'LOAN',
      eligibleBusinessStages: ['POST_REGISTRATION'],
      region: { scope: 'NATIONWIDE', districtCodes: [], note: null },
      purpose: {
        included: [],
        excluded: [],
        note: '소진공 정책자금 표는 자금별 지원 용도를 구조화해 주지 않습니다. 신청안내자료에서 확인해야 합니다.',
      },
      industryConditions: {
        scope: 'UNKNOWN',
        included: [],
        excluded: [],
        note: `소진공 공통 ${overview.excludedIndustries ?? '제외업종 표기 없음'}. 상권 업종 코드로 옮기지 않았으므로 신청안내자료에서 확인해야 합니다.`,
      },
      applicationPeriod: application.period,
      observedApplicationStatus: application.status,
      observedAt: context.asOfDate,
      reviewedAt: context.asOfDate,
      nextReviewAt: null,
      officialUrl: noticeUrl ?? SEMAS_OLS_URLS.overview,
      sourceDocumentName: notice === null ? OVERVIEW_DOCUMENT : `소진공 정책자금 공지사항 · ${notice.detail.title}`,
      sourceDocumentRetrieved: false,
      sourceChecksum: null,
      publicLimit: parseSemasSingleLimit(row.limit),
      interestCondition:
        overview.baseRate === null ? `대출금리 ${row.rate}` : `대출금리 ${row.rate} (${overview.baseRate})`,
      interestRateConfirmed: false,
      interestRatePercent: null,
      repaymentCondition: `대출기간 ${row.term}`,
      repaymentMethod: 'UNKNOWN',
      repaymentTermMonths: null,
      repaymentGraceMonths: null,
      unsupportedCalculationReasons: [
        rateReason(row.rate),
        '소진공 정책자금 표에는 상환방식이 없어 상환 계산 대상이 아닙니다.',
      ],
      additionalChecks,
      evidence,
      sourceRef: { source: 'SEMAS_OLS', externalId },
    });
  }

  const unmatchedCards = cards
    .filter((card) => !matchedCards.has(card))
    .map((card) => `${card.section} '${card.name}' (${card.status})`);
  return { products, duplicateRows, unmatchedCards };
}

function snippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export type SemasFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type SemasOlsAdapterOptions = {
  // User-Agent에 밝히는 운영자 연락처(FUNDING_SYNC_CONTACT, 예: 메일 주소나 웹 주소). 없으면 수집하지 않는다.
  contact: string | undefined;
  fetchImpl?: SemasFetch;
  // 요청 사이 간격. SEMAS_OLS_MIN_REQUEST_INTERVAL_MS보다 짧게 줄 수 없다.
  requestIntervalMs?: number;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  // 테스트가 실제로 기다리지 않도록 바꿔 끼운다.
  sleep?: (ms: number) => Promise<void>;
};

class RetryableSemasError extends Error {}

// fetch가 응답을 받기 전에 실패한 경우(연결·시간 초과)만 다시 시도한다.
function isNetworkError(error: Error): boolean {
  return error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError';
}

export function semasUserAgent(contact: string): string {
  return `TrendBench-funding-sync/1.0 (+${contact})`;
}

function normalizeContact(raw: string | undefined): string {
  const contact = raw?.trim() ?? '';
  if (contact === '') {
    throw new Error(
      'FUNDING_SYNC_CONTACT가 없어 소진공 정책자금 사이트를 수집하지 않았습니다. 크롤링 요청에는 서비스 이름과 운영자 연락처를 밝힙니다(ADR 0006 3절).',
    );
  }
  if (!/^[\x21-\x7e][\x20-\x7e]{0,199}$/.test(contact)) {
    throw new Error('FUNDING_SYNC_CONTACT는 200자 이하의 영문·숫자·기호(ASCII)여야 합니다. 예: 메일 주소나 웹 주소');
  }
  return contact;
}

export function createSemasOlsAdapter(options: SemasOlsAdapterOptions): FundingSourceAdapter {
  const fetchImpl: SemasFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const interval = Math.max(SEMAS_OLS_MIN_REQUEST_INTERVAL_MS, options.requestIntervalMs ?? 1500);
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 30000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    source: 'SEMAS_OLS',
    async collect({ asOfDate, log }): Promise<FundingSourceCollection> {
      const userAgent = semasUserAgent(normalizeContact(options.contact));
      let requestCount = 0;
      const pageDigests: string[] = [];

      async function request(
        url: string,
        init: { method: 'GET' | 'POST'; body?: string; headers?: Record<string, string> },
        allowNotFound = false,
      ): Promise<{ status: number; body: string }> {
        let lastError = '';
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          if (requestCount > 0)
            await sleep(attempt === 0 ? interval : Math.max(interval, retryDelayMs * 2 ** (attempt - 1)));
          requestCount += 1;
          try {
            const response = await fetchImpl(url, {
              method: init.method,
              headers: { 'User-Agent': userAgent, ...init.headers },
              body: init.body,
              signal: AbortSignal.timeout(timeoutMs),
            });
            const body = await response.text();
            if (response.status === 403 || response.status === 429) {
              // 차단은 우회하지 않고 다시 시도하지도 않는다(ADR 0006 3절).
              throw new Error(
                `소진공 정책자금 사이트가 요청을 거부했습니다(HTTP ${response.status}, ${url}). 이 출처를 실패로 기록하고 멈춥니다.`,
              );
            }
            if (response.status >= 500) throw new RetryableSemasError(`HTTP ${response.status}`);
            if (allowNotFound && response.status === 404) return { status: response.status, body };
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`소진공 정책자금 사이트가 HTTP ${response.status}로 응답했습니다(${url}).`);
            }
            if (BLOCK_PAGE_PATTERN.test(body)) {
              throw new Error(
                `소진공 정책자금 사이트가 자동 입력 방지 화면을 보냈습니다(${url}). 이 출처를 실패로 기록하고 멈춥니다.`,
              );
            }
            return { status: response.status, body };
          } catch (error) {
            if (!(error instanceof RetryableSemasError) && error instanceof Error && !isNetworkError(error))
              throw error;
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        throw new Error(`소진공 정책자금 사이트 요청이 ${retries + 1}번 실패했습니다(${url}): ${lastError}`);
      }

      // 응답 본문과 그 SHA-256. 응답 전체의 checksum은 읽은 순서대로 페이지 checksum을 모아 만든다.
      async function page(
        url: string,
        init: { method: 'GET' | 'POST'; body?: string; headers?: Record<string, string> } = { method: 'GET' },
      ): Promise<{ body: string; checksum: string }> {
        const { body } = await request(url, init);
        const checksum = createHash('sha256').update(body, 'utf8').digest('hex');
        pageDigests.push(`${init.method} ${url} ${init.body ?? ''} ${checksum}`);
        return { body, checksum };
      }

      // 2026-09-28 확인 때 robots.txt가 없었다. 생기거나 바뀌면 사람이 허용 여부를 다시 확인할 때까지 멈춘다.
      const robots = await request(SEMAS_OLS_URLS.robots, { method: 'GET' }, true);
      if (robots.status !== 404) {
        throw new Error(
          'ols.semas.or.kr에 robots.txt가 생겼습니다(2026-09-28 확인 때는 없음). 허용 여부를 사람이 확인해 docs/domains/funding.md에 기록하기 전에는 수집하지 않습니다.',
        );
      }

      const overviewPage = await page(SEMAS_OLS_URLS.overview);
      const overview = parseSemasOverview(overviewPage.body);
      const homePage = await page(SEMAS_OLS_URLS.home);
      const cards = parseSemasHomeCards(homePage.body);

      const notices: SemasNotice[] = [];
      let malformedNotices = 0;
      let totalPages = 1;
      let totalNotices = 0;
      for (let pageNo = 1; pageNo <= Math.min(totalPages, SEMAS_OLS_MAX_NOTICE_PAGES); pageNo += 1) {
        const form = new URLSearchParams({ bltwtrClcd: '', bltwtrTitNm: '', searchStd: '', pageNo: String(pageNo) });
        const listPage = await page(SEMAS_OLS_URLS.noticeList, {
          method: 'POST',
          body: form.toString(),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
          },
        });
        const parsed = parseSemasNoticePage(listPage.body);
        if (pageNo === 1) {
          totalPages = parsed.totalPages;
          totalNotices = parsed.totalCount;
        }
        if (parsed.notices.length + parsed.malformed === 0 && pageNo <= totalPages) {
          throw new Error(
            `소진공 공지 목록 ${pageNo}쪽이 비어 있습니다(전체 ${totalPages}쪽). 잘린 응답은 실패로 기록합니다.`,
          );
        }
        notices.push(...parsed.notices);
        malformedNotices += parsed.malformed;
      }
      if (totalPages > SEMAS_OLS_MAX_NOTICE_PAGES) {
        log(`소진공: 공지 목록 ${totalPages}쪽 중 최근 ${SEMAS_OLS_MAX_NOTICE_PAGES}쪽만 읽었습니다.`);
      } else if (notices.length + malformedNotices < totalNotices) {
        throw new Error(
          `소진공 공지 전체 ${totalNotices}건 중 ${notices.length + malformedNotices}건만 받았습니다. 잘린 응답은 실패로 기록합니다.`,
        );
      }

      const selected = selectSemasFundNotices(overview.rows, notices);
      const details = new Map<string, SemasFundNotice>();
      for (const row of overview.rows) {
        const key = semasFundExternalId(row);
        const notice = selected.get(key);
        if (notice === undefined || details.has(key)) continue;
        const detailPage = await page(semasNoticeUrl(notice));
        const detail = parseSemasNoticeDetail(detailPage.body);
        if (!isSemasFundNotice(row, { ...notice, title: detail.title })) {
          throw new Error(
            `소진공 공지 ${notice.seq}의 상세 제목 '${detail.title}'이 목록 제목 '${notice.title}'과 맞지 않습니다.`,
          );
        }
        details.set(key, { notice, detail, checksum: detailPage.checksum });
      }

      const mapping = mapSemasFunds(
        {
          overview,
          cards,
          notices: details,
          pageChecksums: { overview: overviewPage.checksum, home: homePage.checksum },
        },
        { asOfDate },
      );
      const open = mapping.products.filter((product) => product.observedApplicationStatus === 'OPEN').length;
      log(
        `소진공: 정책자금 표의 자금 ${overview.rows.length}건으로 상품 ${mapping.products.length}건을 만들었습니다(접수 중 ${open}건, 접수 안내 공지 연결 ${details.size}건, 공지 ${notices.length}건 확인${malformedNotices > 0 ? `, 형식 오류 공지 ${malformedNotices}건` : ''}${mapping.duplicateRows > 0 ? `, 중복 행 ${mapping.duplicateRows}건` : ''}).`,
      );
      if (mapping.unmatchedCards.length > 0) {
        log(`소진공: 정책자금 표에 없는 홈 화면 대출 카드: ${mapping.unmatchedCards.join(', ')}`);
      }
      const responseChecksum = createHash('sha256').update(pageDigests.join('\n'), 'utf8').digest('hex');
      return { products: mapping.products, fetchedCount: overview.rows.length, responseChecksum };
    },
  };
}
