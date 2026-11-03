import { createHash } from 'node:crypto';
import { z } from 'zod';
import { secretMasker, type FetchLike } from '../../market/seoul-api.ts';
import type { NoticeDownload, NoticeFilePart } from '../notice-body.ts';
import type { CollectedFundingProduct, FundingSourceAdapter, FundingSourceCollection } from '../sync.ts';
import { compareIsoDates, isOfficialUrl, isRealDate } from '../types.ts';

// 기업마당 지원사업정보 Open API(중소벤처기업부). 목록 항목으로는 사업 단계·지원 유형·대상 지역을 알 수 없어
// 상품에는 미확인으로 두고, 조건은 공고 본문에서 AI가 읽는다(ADR 0009 §2·§7).
export const BIZINFO_API_URL = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';
const BIZINFO_ORIGIN = 'https://www.bizinfo.go.kr';

// 요청 한 번으로 현재 공고 전체를 받는다(2026-09-28 기준 1,554건). 응답의 전체 건수(totCnt)보다
// 적게 받으면 잘린 응답이라 실패로 기록한다.
export const BIZINFO_SEARCH_COUNT = 5000;

// 수집 범위. 지원대상 태그(trgetNm)에 이 값이 있는 공고만 올린다. 음식점 창업과
// 무관한 수출·기술개발 공고가 대부분인 중소기업 전용 공고를 빼기 위한 기계적인 거름이다.
export const BIZINFO_TARGET_TAGS: readonly string[] = ['소상공인', '창업벤처'];

const EVIDENCE_DOCUMENT_NAME = '기업마당 지원사업정보 API 응답';

const text = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((value) => (value === null || value === undefined ? '' : String(value).trim()));

const bizinfoItemSchema = z.object({
  pblancId: text,
  pblancNm: text,
  pblancUrl: text,
  jrsdInsttNm: text,
  excInsttNm: text,
  reqstBeginEndDe: text,
  trgetNm: text,
  pldirSportRealmLclasCodeNm: text,
  totCnt: text,
  // 사업개요, 본문출력파일, 첨부(ADR 0009 §2).
  bsnsSumryCn: text,
  printFlpthNm: text,
  printFileNm: text,
  flpthNm: text,
  fileNm: text,
});

type BizinfoItem = z.infer<typeof bizinfoItemSchema>;

export type BizinfoSkipCounts = {
  // 지원대상 태그에 소상공인·창업벤처가 없는 공고.
  notTarget: number;
  // 신청 종료일이 판정 기준일보다 앞선 공고.
  ended: number;
  // 공고 식별자·이름·주소·기관이 없거나 쓸 수 없는 공고.
  malformed: number;
  // 같은 공고 식별자가 앞에 이미 있던 공고.
  duplicate: number;
};

export type BizinfoMapping = { products: CollectedFundingProduct[]; skipped: BizinfoSkipCounts };

export type BizinfoAdapterOptions = {
  // BIZINFO_API_KEY. 없으면 수집하지 않고 그 출처를 실패로 기록한다.
  apiKey: string | undefined;
  fetchImpl?: FetchLike;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  // 공고 파일 받기 설정. 동기화마다 새 downloader를 만든다.
  files?: BizinfoFileDownloaderOptions;
};

class RetryableBizinfoError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

// 공고명·기관명에 남은 HTML 엔티티를 풀고 공백을 하나로 줄인다.
function cleanText(value: string): string {
  return value
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#')) {
        const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        // 유니코드 범위 밖이나 NUL은 풀지 않고 지운다. 잘못된 엔티티 하나로 출처 전체가 실패하지 않게 한다.
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// 신청기간 표기 "YYYY-MM-DD ~ YYYY-MM-DD"만 날짜로 읽는다. "예산 소진시까지" 같은 문장은 날짜로 추측하지 않는다.
export function parseBizinfoPeriod(raw: string): { start: string; end: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const [, start, end] = match;
  if (!isRealDate(start) || !isRealDate(end) || compareIsoDates(end, start) < 0) return null;
  return { start, end };
}

// 공고 주소는 기업마당 기준 상대 경로일 수 있다. 같은 호스트의 http 주소는 https로 읽는다.
function noticeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, BIZINFO_ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' && (url.hostname === 'www.bizinfo.go.kr' || url.hostname === 'bizinfo.go.kr')) {
    url.protocol = 'https:';
  }
  const value = url.toString();
  return isOfficialUrl(value) ? value : null;
}

// 파일 항목 하나에 여러 파일이 오면 '@'로 잇는다(2026-11-03 실제 응답 확인). 주소와 이름은 같은 순서다.
function splitFileField(value: string): string[] {
  return value
    .split('@')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// 파일 받기가 요청하는 주소(https www.bizinfo.go.kr의 공고 파일 경로)만 계획에 넣는다. www 없는 주소는 같은
// 곳으로 읽는다. 다른 주소를 넣으면 받지 못한 파일로 남아 그 공고의 본문을 날마다 새로 읽게 된다.
function bizinfoFileUrl(raw: string): string | null {
  const official = noticeUrl(raw);
  if (official === null) return null;
  const url = new URL(official);
  if (url.hostname === 'bizinfo.go.kr') url.hostname = 'www.bizinfo.go.kr';
  return url.hostname === 'www.bizinfo.go.kr' && url.pathname === BIZINFO_FILE_PATH ? url.toString() : null;
}

// 파일 주소에는 API 호출 때마다 새로 발급되는 downloadToken이 붙는다. 파일을 알아보고 기록할 때는 뺀다.
function withoutDownloadToken(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('downloadToken');
  return parsed.toString();
}

// 본문출력파일과 첨부. 파일 주소는 공식 기업마당 주소일 때만 쓴다.
export function bizinfoNoticeFiles(
  item: Pick<BizinfoItem, 'printFlpthNm' | 'printFileNm' | 'flpthNm' | 'fileNm'>,
): NoticeFilePart[] {
  const files: NoticeFilePart[] = [];
  for (const [kind, rawPaths, rawNames] of [
    ['PRINT_FILE', item.printFlpthNm, item.printFileNm],
    ['ATTACHMENT', item.flpthNm, item.fileNm],
  ] as const) {
    const paths = splitFileField(rawPaths);
    const names = splitFileField(rawNames);
    // 개수가 다르면 어느 이름이 어느 파일인지 알 수 없다. 이름 없이 남겨 형식을 알 수 없는 파일로 기록한다.
    const paired = paths.length === names.length;
    for (const [index, path] of paths.entries()) {
      const downloadUrl = bizinfoFileUrl(path);
      if (downloadUrl === null) continue;
      const url = withoutDownloadToken(downloadUrl);
      files.push({
        kind,
        name: paired ? cleanText(names[index]) : '',
        url,
        ...(url === downloadUrl ? {} : { downloadUrl }),
      });
    }
  }
  return files;
}

// 사업개요의 HTML 태그를 줄바꿈으로 바꾸고 엔티티를 푼다. 줄 구조는 남긴다.
function summaryText(raw: string): string {
  // 사업개요는 HTML이 그대로 오기도 하고 엔티티로 감싸여 오기도 한다. 엔티티로 감싼 태그(&lt;p&gt; 등)만 태그로
  // 되돌리고, 엔티티는 한 번만 푼다. 모두 푼 뒤에 태그를 지우면 본문의 부등호(&lt; 10억 &gt;)까지 태그로 지워진다.
  const escapedTag = /&lt;(\/?[a-z][a-z0-9]*(?:\s(?:[^&<>]|&quot;|&#39;|&amp;)*)?\/?)&gt;/gi;
  return raw
    .replace(escapedTag, '<$1>')
    .replace(/<\s*br\s*\/?>|<\/\s*(p|div|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map(cleanText)
    .filter((line) => line !== '')
    .join('\n');
}

function productKeyFor(pblancId: string): string | null {
  const slug = pblancId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const key = `bizinfo-${slug}`;
  return slug.length > 0 && /^[a-z0-9][a-z0-9-]{2,63}$/.test(key) ? key : null;
}

function organizationFor(item: BizinfoItem): string | null {
  const jurisdiction = cleanText(item.jrsdInsttNm);
  const executor = cleanText(item.excInsttNm);
  const parts = [jurisdiction, executor].filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
  const organization = parts.join(' · ');
  if (organization.length < 2) return null;
  return organization.length > 200 ? `${organization.slice(0, 199)}…` : organization;
}

// 기업마당 응답의 공고를 카탈로그 상품으로 바꾼다. 원문이 주지 않는 사업 단계·지원 유형·지역·용도·업종은
// 추측하지 않고 미확인으로 남긴다. 판정 기준일에 이미 끝난 공고는 올리지 않는다.
export function mapBizinfoItems(
  items: readonly unknown[],
  context: { asOfDate: string; responseChecksum: string },
): BizinfoMapping {
  const skipped: BizinfoSkipCounts = { notTarget: 0, ended: 0, malformed: 0, duplicate: 0 };
  const products: CollectedFundingProduct[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const parsed = bizinfoItemSchema.safeParse(raw);
    if (!parsed.success) {
      skipped.malformed += 1;
      continue;
    }
    const item = parsed.data;
    const name = cleanText(item.pblancNm);
    const productKey = productKeyFor(item.pblancId);
    const officialUrl = noticeUrl(item.pblancUrl);
    const organization = organizationFor(item);
    if (productKey === null || name.length < 2 || officialUrl === null || organization === null) {
      skipped.malformed += 1;
      continue;
    }
    if (seen.has(item.pblancId)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(item.pblancId);

    const target = cleanText(item.trgetNm);
    if (!BIZINFO_TARGET_TAGS.some((tag) => target.includes(tag))) {
      skipped.notTarget += 1;
      continue;
    }
    const periodText = cleanText(item.reqstBeginEndDe);
    const period = parseBizinfoPeriod(periodText);
    if (period !== null && compareIsoDates(period.end, context.asOfDate) < 0) {
      skipped.ended += 1;
      continue;
    }
    const open =
      period !== null &&
      compareIsoDates(period.start, context.asOfDate) <= 0 &&
      compareIsoDates(context.asOfDate, period.end) <= 0;
    const realm = cleanText(item.pldirSportRealmLclasCodeNm);

    const evidenceBase = {
      sourceUrl: officialUrl,
      sourceDocumentName: EVIDENCE_DOCUMENT_NAME,
      observedAt: context.asOfDate,
      retrievalMethod: 'OFFICIAL_API' as const,
      checksum: context.responseChecksum,
    };
    const evidence: CollectedFundingProduct['evidence'] = [
      {
        ...evidenceBase,
        id: 'bizinfo-identity',
        subject: 'IDENTITY',
        summary: `기업마당 공고 ${item.pblancId}: '${name}' (${organization})`,
      },
      {
        ...evidenceBase,
        id: 'bizinfo-period',
        subject: 'APPLICATION_PERIOD',
        summary: `신청기간 표기: '${periodText === '' ? '없음' : periodText}'`,
      },
    ];

    products.push({
      productKey,
      name: name.length > 200 ? `${name.slice(0, 199)}…` : name,
      organization,
      supportType: 'UNKNOWN',
      eligibleBusinessStages: [],
      // 공고명 [지역] 표시나 소관기관으로 지역을 추측하지 않는다. 지역으로 거르지도 않는다(ADR 0009 §2·§7).
      region: {
        scope: 'UNKNOWN',
        districtCodes: [],
        note: '기업마당 공고에서 대상 지역을 확인하지 못했습니다. 원 공고에서 확인해야 합니다.',
      },
      purpose: {
        included: [],
        excluded: [],
        note: '기업마당 공고는 지원 용도를 알려 주지 않습니다. 원 공고에서 확인해야 합니다.',
      },
      industryConditions: {
        scope: 'UNKNOWN',
        included: [],
        excluded: [],
        note: '기업마당 공고는 지원·제외 업종을 알려 주지 않습니다. 원 공고에서 확인해야 합니다.',
      },
      applicationPeriod:
        period === null
          ? { start: null, end: null, note: periodText === '' ? '기업마당 공고에 신청기간이 없습니다.' : periodText }
          : { start: period.start, end: period.end, note: null },
      observedApplicationStatus: open ? 'OPEN' : 'UNKNOWN',
      observedAt: context.asOfDate,
      reviewedAt: context.asOfDate,
      nextReviewAt: null,
      officialUrl,
      sourceDocumentName: '기업마당 지원사업 공고',
      sourceDocumentRetrieved: false,
      sourceChecksum: null,
      publicLimit: null,
      interestCondition: null,
      interestRateConfirmed: false,
      interestRatePercent: null,
      repaymentCondition: null,
      repaymentMethod: 'UNKNOWN',
      repaymentTermMonths: null,
      repaymentGraceMonths: null,
      unsupportedCalculationReasons: [
        '기업마당 공고는 지원 유형과 금리·기간·상환 조건을 알려 주지 않아 상환 계산 대상이 아닙니다.',
      ],
      additionalChecks: [
        `기업마당 지원대상 표시: ${target}`,
        ...(realm === '' ? [] : [`기업마당 지원분야 표시: ${realm}`]),
        '사업 단계·지원 유형·지원 용도·제외 업종은 원 공고에서 확인해야 합니다.',
      ],
      evidence,
      sourceRef: { source: 'BIZINFO', externalId: item.pblancId },
      // 지원분야는 정책자금·지원사업 갈래를 정하는 출처 항목이다(ADR 0009 §1). 값이 없으면 남기지 않는다.
      ...(realm === '' ? {} : { sourceCategory: realm.slice(0, 100) }),
      notice: {
        sourceUrl: officialUrl,
        inline: [
          { kind: 'API_SUMMARY', name: '기업마당 사업개요', url: officialUrl, text: summaryText(item.bsnsSumryCn) },
        ],
        files: bizinfoNoticeFiles(item),
      },
    });
  }
  return { products, skipped };
}

function snippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function createBizinfoAdapter(options: BizinfoAdapterOptions): FundingSourceAdapter {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 60000;
  let fileDownloader = createBizinfoFileDownloader(options.files ?? { contact: undefined });

  async function request(apiKey: string): Promise<string> {
    const url = new URL(BIZINFO_API_URL);
    url.searchParams.set('crtfcKey', apiKey);
    url.searchParams.set('dataType', 'json');
    url.searchParams.set('searchCnt', String(BIZINFO_SEARCH_COUNT));
    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
      try {
        const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
        const body = await response.text();
        if (response.status === 403 || response.status === 429) {
          // 차단은 우회하지 않고 다시 시도하지도 않는다(ADR 0006 3절).
          throw new Error(
            `기업마당이 요청을 거부했습니다(HTTP ${response.status}). 이 출처를 실패로 기록하고 멈춥니다.`,
          );
        }
        if (response.status >= 500) throw new RetryableBizinfoError(`HTTP ${response.status}`);
        if (response.status >= 400) throw new Error(`기업마당 API가 HTTP ${response.status}로 응답했습니다.`);
        return body;
      } catch (error) {
        if (!(error instanceof RetryableBizinfoError) && error instanceof Error && !isNetworkError(error)) throw error;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`기업마당 API 요청이 ${retries + 1}번 실패했습니다: ${lastError}`);
  }

  return {
    source: 'BIZINFO',
    downloadNoticeFile: (url) => fileDownloader(url),
    async collect({ asOfDate, log }): Promise<FundingSourceCollection> {
      // robots.txt 확인과 403·429 멈춤은 동기화마다 새로 시작한다.
      fileDownloader = createBizinfoFileDownloader(options.files ?? { contact: undefined });
      const apiKey = options.apiKey?.trim() ?? '';
      if (apiKey === '') {
        throw new Error('BIZINFO_API_KEY가 없어 기업마당 공고를 받지 못했습니다. 키 값은 Git에 추가하지 마세요.');
      }
      // 요청 주소에 키가 들어가므로 어떤 오류 문장에도 키가 남지 않게 가린다.
      const mask = secretMasker(apiKey);
      try {
        const body = await request(apiKey);
        const responseChecksum = createHash('sha256').update(body, 'utf8').digest('hex');
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error(`기업마당 응답이 JSON이 아닙니다(인증키 오류일 수 있습니다): ${snippet(body)}`);
        }
        const items = (parsed as { jsonArray?: unknown } | null)?.jsonArray;
        if (!Array.isArray(items)) {
          const keys =
            parsed !== null && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 5).join(', ') : typeof parsed;
          throw new Error(`기업마당 응답에 공고 목록(jsonArray)이 없습니다. 응답 항목: ${keys || '없음'}`);
        }
        const total = Number((items[0] as { totCnt?: unknown } | undefined)?.totCnt);
        if (Number.isSafeInteger(total) && total > items.length) {
          throw new Error(
            `기업마당 전체 공고 ${total}건 중 ${items.length}건만 받았습니다. 잘린 응답은 실패로 기록합니다.`,
          );
        }
        const mapping = mapBizinfoItems(items, { asOfDate, responseChecksum });
        const { skipped } = mapping;
        log(
          mask(
            `기업마당: 공고 ${items.length}건 중 ${mapping.products.length}건을 상품으로 만들었습니다(대상 아님 ${skipped.notTarget}건, 신청 종료 ${skipped.ended}건, 형식 오류 ${skipped.malformed}건, 중복 ${skipped.duplicate}건).`,
          ),
        );
        return { products: mapping.products, fetchedCount: items.length, responseChecksum };
      } catch (error) {
        throw new Error(mask(error instanceof Error ? error.message : String(error)));
      }
    },
  };
}

export type BizinfoFileFetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: 'manual' | 'follow'; signal?: AbortSignal },
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export type BizinfoFileDownloaderOptions = {
  // FUNDING_SYNC_CONTACT. 파일 요청의 User-Agent에 밝힌다. 없으면 파일을 받지 않는다(ADR 0006 3절).
  contact: string | undefined;
  fetchImpl?: BizinfoFileFetch;
  // 요청 사이 간격. 1초보다 짧게 줄 수 없다.
  requestIntervalMs?: number;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const BIZINFO_ROBOTS_URL = `${BIZINFO_ORIGIN}/robots.txt`;
// 2026-11-02 확인 때 robots.txt가 막지 않은 공고 파일 경로. 이 경로 밖은 요청하지 않는다.
const BIZINFO_FILE_PATH = '/cmm/fms/getImageFile.do';
const MIN_FILE_REQUEST_INTERVAL_MS = 1000;

// robots.txt에서 모든 로봇(User-agent: *)에 적용되는 Disallow가 파일 경로를 막는지 본다.
// 규칙은 RFC 9309를 따른다: `*`는 아무 글자, 끝의 `$`는 경로 끝이고, 가장 길게 맞는 규칙이 이기며
// 길이가 같으면 Allow가 이긴다. 파일 주소는 경로 뒤에 atchFileId 질의가 붙는 모양으로 본다.
export function bizinfoRobotsDisallowFiles(robots: string): boolean {
  const path = `${BIZINFO_FILE_PATH}?atchFileId=FILE`;
  let applies = false;
  let inAgents = false;
  let best: { length: number; allow: boolean } | null = null;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (match === null) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      // 연달아 오는 User-agent 줄은 한 묶음이다.
      applies = (inAgents && applies) || value === '*';
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (!applies || (field !== 'allow' && field !== 'disallow') || value === '') continue;
    const anchored = value.endsWith('$');
    const pattern = (anchored ? value.slice(0, -1) : value)
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (!new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path)) continue;
    const allow = field === 'allow';
    if (best === null || value.length > best.length || (value.length === best.length && allow)) {
      best = { length: value.length, allow };
    }
  }
  return best !== null && !best.allow;
}

// 기업마당 공고 파일(본문출력파일·첨부)을 받는다. 동기화 한 번에 하나를 만들어 쓴다:
// 처음 요청 전에 robots.txt를 한 번 확인하고, 403·429를 만나면 그 뒤로는 요청하지 않는다.
export function createBizinfoFileDownloader(options: BizinfoFileDownloaderOptions): NoticeDownload {
  const fetchImpl: BizinfoFileFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const interval = Math.max(MIN_FILE_REQUEST_INTERVAL_MS, options.requestIntervalMs ?? MIN_FILE_REQUEST_INTERVAL_MS);
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 60000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const contact = options.contact?.trim() ?? '';
  const userAgent = `TrendBench-funding-sync/1.0 (+${contact})`;
  let requestCount = 0;
  let robotsChecked = false;
  // 이번 동기화에서 더 받지 않는 이유. null이면 받는다.
  let stopped: string | null = null;

  // 공고 파일은 다른 경로로 넘기는 응답을 따라가지 않는다. 그 경로는 robots.txt와 경로 검사를 거치지 않았다.
  // robots.txt는 넘김을 따라간다(RFC 9309 2.3.1.2).
  async function send(url: string, redirect: 'manual' | 'follow') {
    if (requestCount > 0) await sleep(interval);
    requestCount += 1;
    return fetchImpl(url, { headers: { 'User-Agent': userAgent }, redirect, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function checkRobots(): Promise<string | null> {
    try {
      const response = await send(BIZINFO_ROBOTS_URL, 'follow');
      if (response.status === 404) return null;
      if (response.status !== 200) return `robots.txt를 확인하지 못했습니다(HTTP ${response.status}).`;
      const robots = new TextDecoder().decode(await response.arrayBuffer());
      return bizinfoRobotsDisallowFiles(robots)
        ? `robots.txt가 공고 파일 경로(${BIZINFO_FILE_PATH})를 막습니다.`
        : null;
    } catch (error) {
      return `robots.txt를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return async (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, transient: false, message: '파일 주소가 아닙니다.' };
    }
    if (url.protocol !== 'https:' || url.hostname !== 'www.bizinfo.go.kr' || url.pathname !== BIZINFO_FILE_PATH) {
      return {
        ok: false,
        transient: false,
        message: `기업마당 공고 파일 경로가 아니어서 받지 않습니다: ${url.origin}${url.pathname}`,
      };
    }
    if (!/^[\x21-\x7e][\x20-\x7e]{0,199}$/.test(contact)) {
      return {
        ok: false,
        transient: true,
        message: 'FUNDING_SYNC_CONTACT가 없거나 헤더에 쓸 수 없어 공고 파일을 받지 않았습니다(ADR 0006 3절).',
      };
    }
    if (!robotsChecked) {
      robotsChecked = true;
      stopped = await checkRobots();
    }
    if (stopped !== null) return { ok: false, transient: true, message: stopped };

    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0 && retryDelayMs > interval) await sleep(retryDelayMs * 2 ** (attempt - 1) - interval);
      try {
        const response = await send(url.toString(), 'manual');
        if (response.status === 403 || response.status === 429) {
          // 차단은 우회하지 않는다. 이번 동기화에서는 더 요청하지 않는다(ADR 0006 3절).
          stopped = `기업마당이 파일 요청을 거부했습니다(HTTP ${response.status}). 이번 동기화에서는 파일을 더 받지 않습니다.`;
          return { ok: false, transient: true, message: stopped };
        }
        if (response.status >= 500) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        if (response.status !== 200) return { ok: false, transient: false, message: `HTTP ${response.status}` };
        return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) };
      } catch (error) {
        if (!(error instanceof Error) || !isNetworkError(error)) throw error;
        lastError = error.message;
      }
    }
    return { ok: false, transient: true, message: `${retries + 1}번 요청이 실패했습니다: ${lastError}` };
  };
}

// fetch가 응답을 받기 전에 실패한 경우(연결·시간 초과)만 다시 시도한다.
function isNetworkError(error: Error): boolean {
  return error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError';
}
