import { secretMasker } from '../market/seoul-api.ts';
import { FTC_API_BASE, FTC_API_PAGE_SIZE } from './types.ts';

export class FranchiseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'FranchiseError';
  }
}

export type FtcRow = Readonly<Record<string, unknown>>;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type FtcApiClientOptions = {
  serviceKey: string;
  fetchImpl?: FetchLike;
  pageSize?: number;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

type PageResult = { total: number; rows: FtcRow[] };

class RetryableApiError extends Error {}

// 정상 응답은 {resultCode, resultMsg, totalCount, items: [...]}다. 활용신청하지 않은 키는
// 게이트웨이가 403과 {OpenAPI_ServiceResponse: {cmmMsgHeader: {errMsg}}}를 준다.
function parsePage(label: string, status: number, body: string): PageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (status >= 500) throw new RetryableApiError(`${label}: HTTP ${status}`);
    throw new FranchiseError('SOURCE_API_ERROR', `${label}: JSON이 아닌 응답입니다(HTTP ${status}).`);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const gateway = (record.OpenAPI_ServiceResponse as { cmmMsgHeader?: { errMsg?: unknown } } | undefined)?.cmmMsgHeader;
  if (gateway) {
    const message = typeof gateway.errMsg === 'string' ? gateway.errMsg : '게이트웨이 오류';
    if (message === 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR')
      throw new FranchiseError(
        'SERVICE_NOT_REGISTERED',
        `${label}: 이 인증키로 활용신청되지 않은 API입니다. 공공데이터포털에서 활용신청해 주세요.`,
      );
    if (status >= 500) throw new RetryableApiError(`${label}: ${message}`);
    throw new FranchiseError('SOURCE_API_ERROR', `${label}: ${message}`);
  }
  if (status >= 500) throw new RetryableApiError(`${label}: HTTP ${status}`);
  if (status >= 400) throw new FranchiseError('SOURCE_API_ERROR', `${label}: HTTP ${status}`);
  const code = typeof record.resultCode === 'string' ? record.resultCode : '';
  if (code !== '00') {
    throw new FranchiseError(
      'SOURCE_API_ERROR',
      `${label}: ${code || '결과 코드 없음'} ${String(record.resultMsg ?? '')}`.trim(),
    );
  }
  const total = Number(record.totalCount);
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(record.items)) {
    throw new FranchiseError('SOURCE_API_ERROR', `${label}: 전체 건수나 행 목록이 없는 응답입니다.`);
  }
  return { total, rows: record.items as FtcRow[] };
}

export function createFtcApiClient(options: FtcApiClientOptions) {
  const serviceKey = options.serviceKey.trim();
  if (serviceKey.length === 0) throw new FranchiseError('SOURCE_API_ERROR', '공공데이터포털 인증키가 비어 있습니다.');
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const pageSize = options.pageSize ?? FTC_API_PAGE_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60000;
  const mask = secretMasker(serviceKey);

  async function requestPage(path: string, label: string, year: number, page: number): Promise<PageResult> {
    const url = new URL(`${FTC_API_BASE}/${path}`);
    url.searchParams.set('serviceKey', serviceKey);
    url.searchParams.set('resultType', 'json');
    url.searchParams.set('yr', String(year));
    url.searchParams.set('pageNo', String(page));
    url.searchParams.set('numOfRows', String(pageSize));
    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
      try {
        const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
        return parsePage(label, response.status, await response.text());
      } catch (error) {
        if (error instanceof FranchiseError) throw new FranchiseError(error.code, mask(error.message));
        lastError = mask(error instanceof Error ? error.message : String(error));
      }
    }
    throw new FranchiseError(
      'SOURCE_API_ERROR',
      `${label} ${page}페이지 요청이 ${retries + 1}번 실패했습니다: ${lastError}`,
    );
  }

  // 받은 행 수가 전체 건수와 다르거나, 받는 도중 전체 건수가 바뀌면 적재하지 않는다.
  async function fetchYear(path: string, name: string, year: number) {
    const label = `${name} ${year}`;
    const first = await requestPage(path, label, year, 1);
    const pageCount = Math.ceil(first.total / pageSize);
    const pages: PageResult[] = [first];
    const numbers: number[] = [];
    for (let page = 2; page <= pageCount; page += 1) numbers.push(page);
    for (let index = 0; index < numbers.length; index += concurrency) {
      const batch = numbers.slice(index, index + concurrency);
      pages.push(...(await Promise.all(batch.map((page) => requestPage(path, label, year, page)))));
    }
    for (const page of pages) {
      if (page.total !== first.total)
        throw new FranchiseError(
          'INCOMPLETE_SOURCE',
          `${label}: 받는 도중 전체 건수가 ${first.total}에서 ${page.total}(으)로 바뀌었습니다.`,
        );
    }
    const rows = pages.flatMap((page) => page.rows);
    if (rows.length !== first.total)
      throw new FranchiseError(
        'INCOMPLETE_SOURCE',
        `${label}: 전체 ${first.total}건 중 ${rows.length}건만 받았습니다.`,
      );
    return { total: first.total, rows };
  }

  return { fetchYear };
}

export type FtcApiClient = ReturnType<typeof createFtcApiClient>;
