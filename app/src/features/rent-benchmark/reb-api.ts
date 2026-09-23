import { secretMasker } from '../market/seoul-api.ts';
import { REB_API_BASE, REB_API_PAGE_SIZE } from './types.ts';

export class RentBenchmarkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RentBenchmarkError';
  }
}

export type RebRow = Readonly<Record<string, unknown>>;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type RebApiClientOptions = {
  apiKey: string;
  fetchImpl?: FetchLike;
  pageSize?: number;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

type PageResult = { total: number; rows: RebRow[] };

class RetryableApiError extends Error {}

// R-ONE 응답: 정상은 {서비스: [{head: [{list_total_count}, {RESULT}]}, {row: [...]}]},
// 오류는 최상위 {RESULT: {CODE, MESSAGE}}다. INFO-200은 자료 없음이다.
function parsePage(service: string, label: string, body: string): PageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RetryableApiError(`${label}: JSON이 아닌 응답입니다.`);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(record[service]) ? (record[service] as Array<Record<string, unknown>>) : null;
  const head = Array.isArray(parts?.[0]?.head) ? (parts[0].head as Array<Record<string, unknown>>) : [];
  const result = (head.find((entry) => 'RESULT' in entry)?.RESULT ?? record.RESULT) as
    { CODE?: unknown; MESSAGE?: unknown } | undefined;
  const code = typeof result?.CODE === 'string' ? result.CODE : '';
  const message = typeof result?.MESSAGE === 'string' ? result.MESSAGE : '';
  if (code === 'INFO-200') return { total: 0, rows: [] };
  if (code !== 'INFO-000') {
    const detail = `${label}: ${code || '결과 코드 없음'} ${message}`.trim();
    if (code.startsWith('ERROR-5') || code.startsWith('ERROR-6')) throw new RetryableApiError(detail);
    throw new RentBenchmarkError('SOURCE_API_ERROR', detail);
  }
  const total = Number(head.find((entry) => 'list_total_count' in entry)?.list_total_count);
  const rowPart = parts?.find((entry) => 'row' in entry)?.row;
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(rowPart)) {
    throw new RentBenchmarkError('SOURCE_API_ERROR', `${label}: 전체 건수나 행 목록이 없는 응답입니다.`);
  }
  return { total, rows: rowPart as RebRow[] };
}

export function createRebApiClient(options: RebApiClientOptions) {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) throw new RentBenchmarkError('SOURCE_API_ERROR', '부동산원 인증키가 비어 있습니다.');
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const pageSize = options.pageSize ?? REB_API_PAGE_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60000;
  const mask = secretMasker(apiKey);

  async function requestPage(
    service: string,
    label: string,
    params: Readonly<Record<string, string>>,
    page: number,
  ): Promise<PageResult> {
    const url = new URL(`${REB_API_BASE}/${service}.do`);
    url.searchParams.set('KEY', apiKey);
    url.searchParams.set('Type', 'json');
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    url.searchParams.set('pIndex', String(page));
    url.searchParams.set('pSize', String(pageSize));
    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
      try {
        const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
        const body = await response.text();
        if (response.status >= 500) throw new RetryableApiError(`${label}: HTTP ${response.status}`);
        if (response.status >= 400)
          throw new RentBenchmarkError('SOURCE_API_ERROR', `${label}: HTTP ${response.status}`);
        return parsePage(service, label, body);
      } catch (error) {
        if (error instanceof RentBenchmarkError) throw new RentBenchmarkError(error.code, mask(error.message));
        lastError = mask(error instanceof Error ? error.message : String(error));
      }
    }
    throw new RentBenchmarkError(
      'SOURCE_API_ERROR',
      `${label} ${page}페이지 요청이 ${retries + 1}번 실패했습니다: ${lastError}`,
    );
  }

  // 받은 행 수가 전체 건수와 다르거나, 받는 도중 전체 건수가 바뀌면 적재하지 않는다.
  async function fetchAll(service: string, label: string, params: Readonly<Record<string, string>>) {
    const first = await requestPage(service, label, params, 1);
    const pageCount = Math.ceil(first.total / pageSize);
    const pages: PageResult[] = [first];
    const numbers: number[] = [];
    for (let page = 2; page <= pageCount; page += 1) numbers.push(page);
    for (let index = 0; index < numbers.length; index += concurrency) {
      const batch = numbers.slice(index, index + concurrency);
      pages.push(...(await Promise.all(batch.map((page) => requestPage(service, label, params, page)))));
    }
    for (const page of pages) {
      if (page.total !== first.total) {
        throw new RentBenchmarkError(
          'INCOMPLETE_SOURCE',
          `${label}: 받는 도중 전체 건수가 ${first.total}에서 ${page.total}(으)로 바뀌었습니다.`,
        );
      }
    }
    const rows = pages.flatMap((page) => page.rows);
    if (rows.length !== first.total) {
      throw new RentBenchmarkError(
        'INCOMPLETE_SOURCE',
        `${label}: 전체 ${first.total}건 중 ${rows.length}건만 받았습니다.`,
      );
    }
    return { total: first.total, rows };
  }

  return {
    fetchTableList: () => fetchAll('SttsApiTbl', '통계표 목록', {}),
    fetchTable: (statblId: string, cycle = 'QY') =>
      fetchAll('SttsApiTblData', statblId, { STATBL_ID: statblId, DTACYCLE_CD: cycle }),
  };
}

export type RebApiClient = ReturnType<typeof createRebApiClient>;
