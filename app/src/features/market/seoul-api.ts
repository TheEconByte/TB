import { sha256Hex } from './checksum.ts';
import { AREA_API_FIELD_NAMES, SALES_API_FIELDS, STORES_API_FIELDS } from './headers.ts';
import { previousQuarter, quarterAt } from './quarter.ts';
import type { SourceFileRole } from './source-files.ts';
import { MarketSourceError } from './validation.ts';

// 서울 열린데이터광장 Open API. 운영자 적재 명령에서만 호출하고 웹 요청 중에는 호출하지 않는다.
export const SEOUL_API_BASE = 'http://openapi.seoul.go.kr:8088';
export const SEOUL_API_PAGE_SIZE = 1000;

export type SeoulApiService = {
  role: SourceFileRole;
  service: string;
  datasetId: string;
  datasetName: string;
  url: string;
  fields: readonly string[];
};

export const SEOUL_MARKET_SERVICES: Readonly<Record<SourceFileRole, SeoulApiService>> = {
  areas: {
    role: 'areas',
    service: 'TbgisTrdarRelm',
    datasetId: 'OA-15560',
    datasetName: '영역-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do',
    fields: AREA_API_FIELD_NAMES,
  },
  sales: {
    role: 'sales',
    service: 'VwsmTrdarSelngQq',
    datasetId: 'OA-15572',
    datasetName: '추정매출-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15572/S/1/datasetView.do',
    fields: Object.keys(SALES_API_FIELDS),
  },
  stores: {
    role: 'stores',
    service: 'VwsmTrdarStorQq',
    datasetId: 'OA-15577',
    datasetName: '점포-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15577/S/1/datasetView.do',
    fields: Object.keys(STORES_API_FIELDS),
  },
};

export type SeoulApiRow = Readonly<Record<string, unknown>>;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type SeoulApiClientOptions = {
  apiKey: string;
  fetchImpl?: FetchLike;
  pageSize?: number;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

export type SeoulApiResult = { total: number; rows: SeoulApiRow[]; bytes: number };

type PageResult = { total: number; rows: SeoulApiRow[]; bytes: number };

class RetryableApiError extends Error {}

// 키는 원문·디코딩·인코딩 형태로 모두 가린다. 응답이 키를 다른 형태로 되돌려 줘도 새지 않게 하기 위해서다.
export function secretMasker(secret: string): (text: string) => string {
  const forms = new Set<string>([secret]);
  try {
    forms.add(decodeURIComponent(secret));
  } catch {
    // 디코딩할 수 없는 키는 원문만 가린다.
  }
  forms.add(encodeURIComponent(secret));
  const ordered = [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((out, form) => out.split(form).join('***'), text);
}

function parsePage(service: string, body: string): PageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RetryableApiError(`${service}: JSON이 아닌 응답입니다.`);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const root = (record[service] ?? record) as {
    list_total_count?: unknown;
    RESULT?: { CODE?: unknown; MESSAGE?: unknown };
    row?: unknown;
  };
  const code = typeof root.RESULT?.CODE === 'string' ? root.RESULT.CODE : '';
  const message = typeof root.RESULT?.MESSAGE === 'string' ? root.RESULT.MESSAGE : '';
  if (code === 'INFO-200') return { total: 0, rows: [], bytes: body.length };
  if (code !== 'INFO-000') {
    const detail = `${service}: ${code || '결과 코드 없음'} ${message}`.trim();
    if (code.startsWith('ERROR-5') || code.startsWith('ERROR-6')) throw new RetryableApiError(detail);
    throw new MarketSourceError('SOURCE_API_ERROR', detail);
  }
  const total = Number(root.list_total_count);
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(root.row)) {
    throw new MarketSourceError('SOURCE_API_ERROR', `${service}: 전체 건수나 행 목록이 없는 응답입니다.`);
  }
  return { total, rows: root.row as SeoulApiRow[], bytes: body.length };
}

export function createSeoulApiClient(options: SeoulApiClientOptions) {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0)
    throw new MarketSourceError('SOURCE_API_ERROR', '서울 열린데이터광장 인증키가 비어 있습니다.');
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const pageSize = options.pageSize ?? SEOUL_API_PAGE_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60000;
  const mask = secretMasker(apiKey);

  async function requestPage(service: string, start: number, end: number, quarter: string | null): Promise<PageResult> {
    const url = `${SEOUL_API_BASE}/${apiKey}/json/${service}/${start}/${end}/${quarter ?? ''}`;
    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        const body = await response.text();
        if (response.status >= 500) throw new RetryableApiError(`${service}: HTTP ${response.status}`);
        if (response.status >= 400) {
          throw new MarketSourceError('SOURCE_API_ERROR', `${service}: HTTP ${response.status}`);
        }
        return parsePage(service, body);
      } catch (error) {
        if (error instanceof MarketSourceError) throw new MarketSourceError(error.code, mask(error.message));
        lastError = mask(error instanceof Error ? error.message : String(error));
      }
    }
    throw new MarketSourceError(
      'SOURCE_API_ERROR',
      `${service}${quarter ? ` ${quarter}` : ''} ${start}~${end}행 요청이 ${retries + 1}번 실패했습니다: ${lastError}`,
    );
  }

  // 한 서비스(와 분기)의 전체 행을 받는다. 받은 행 수가 전체 건수와 다르거나, 받는 도중
  // 전체 건수가 바뀌면 원본이 갱신 중인 것이므로 적재하지 않는다.
  async function fetchAll(service: string, quarter: string | null = null): Promise<SeoulApiResult> {
    const first = await requestPage(service, 1, pageSize, quarter);
    const pageCount = Math.ceil(first.total / pageSize);
    const pages: PageResult[] = [first];
    const starts: number[] = [];
    for (let page = 1; page < pageCount; page += 1) starts.push(page * pageSize + 1);
    for (let index = 0; index < starts.length; index += concurrency) {
      const batch = starts.slice(index, index + concurrency);
      const results = await Promise.all(
        batch.map((start) => requestPage(service, start, Math.min(start + pageSize - 1, first.total), quarter)),
      );
      pages.push(...results);
    }
    const label = `${service}${quarter ? ` ${quarter}` : ''}`;
    for (const page of pages) {
      if (page.total !== first.total) {
        throw new MarketSourceError(
          'INCOMPLETE_SOURCE',
          `${label}: 받는 도중 전체 건수가 ${first.total}에서 ${page.total}(으)로 바뀌었습니다.`,
        );
      }
    }
    const rows = pages.flatMap((page) => page.rows);
    if (rows.length !== first.total) {
      throw new MarketSourceError(
        'INCOMPLETE_SOURCE',
        `${label}: 전체 ${first.total}건 중 ${rows.length}건만 받았습니다.`,
      );
    }
    return { total: first.total, rows, bytes: pages.reduce((sum, page) => sum + page.bytes, 0) };
  }

  async function countRows(service: string, quarter: string): Promise<number> {
    return (await requestPage(service, 1, 1, quarter)).total;
  }

  return { fetchAll, countRows };
}

export type SeoulApiClient = ReturnType<typeof createSeoulApiClient>;

// 매출과 점포가 모두 있는 가장 최근 분기. 지금 분기부터 과거로 최대 8분기를 확인한다.
export async function findLatestQuarter(client: SeoulApiClient, now: Date): Promise<string> {
  let quarter = quarterAt(now);
  for (let step = 0; step < 8; step += 1) {
    const [sales, stores] = await Promise.all([
      client.countRows(SEOUL_MARKET_SERVICES.sales.service, quarter),
      client.countRows(SEOUL_MARKET_SERVICES.stores.service, quarter),
    ]);
    if (sales > 0 && stores > 0) return quarter;
    quarter = previousQuarter(quarter);
  }
  throw new MarketSourceError('SOURCE_API_ERROR', '최근 8분기 안에 매출과 점포가 모두 있는 분기를 찾지 못했습니다.');
}

// 행 순서와 무관한 내용 해시. 필드 순서를 고정한 행 문자열을 정렬해 해시하므로, API가
// 같은 내용을 다른 순서로 돌려줘도 같은 값이 나오고 릴리스 재적재가 중복되지 않는다.
export function canonicalRowsHash(rows: readonly SeoulApiRow[], fields: readonly string[]): string {
  const lines = rows.map((row) => JSON.stringify(fields.map((field) => row[field] ?? null)));
  lines.sort();
  return sha256Hex(lines.join('\n'));
}

// 응답 필드가 기록된 목록과 다르면 누락·예상 밖 필드를 돌려준다.
export function fieldDifferences(row: SeoulApiRow, fields: readonly string[]) {
  const expected = new Set(fields);
  const actual = Object.keys(row);
  return {
    missing: fields.filter((field) => !(field in row)),
    unexpected: actual.filter((field) => !expected.has(field)),
  };
}

// API 값은 숫자·문자열·null로 온다. 적재 검증은 문자열 셀 기준이므로 같은 형태로 바꾼다.
// 정밀도를 잃는 큰 숫자는 빈 값 대신 원문이 드러나도록 표시해 검증에서 걸리게 한다.
export function apiCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number')
    return Number.isSafeInteger(value) || !Number.isInteger(value) ? String(value) : `UNSAFE:${value}`;
  return String(value);
}
