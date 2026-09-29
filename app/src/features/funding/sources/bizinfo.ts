import { createHash } from 'node:crypto';
import { z } from 'zod';
import { secretMasker, type FetchLike } from '../../market/seoul-api.ts';
import { SEOUL_DISTRICTS } from '../districts.ts';
import type { CollectedFundingProduct, FundingSourceAdapter, FundingSourceCollection } from '../sync.ts';
import { compareIsoDates, isOfficialUrl, isRealDate } from '../types.ts';

// 기업마당 지원사업정보 Open API(중소벤처기업부). 새 공고를 찾는 데만 쓰며, 여기서 만든 상품은
// 사업 단계·지원 유형을 알 수 없어 사람이 확인하기 전에는 추가 확인에 머문다(ADR 0006 1·2절).
export const BIZINFO_API_URL = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';
const BIZINFO_ORIGIN = 'https://www.bizinfo.go.kr';

// 요청 한 번으로 현재 공고 전체를 받는다(2026-09-28 기준 1,554건). 응답의 전체 건수(totCnt)보다
// 적게 받으면 잘린 응답이라 실패로 기록한다.
export const BIZINFO_SEARCH_COUNT = 5000;

// 수집 범위. 지원대상 태그(trgetNm)에 이 값이 있는 공고만 추가 확인 후보로 올린다. 음식점 창업과
// 무관한 수출·기술개발 공고가 대부분인 중소기업 전용 공고를 빼기 위한 기계적인 거름이다.
export const BIZINFO_TARGET_TAGS: readonly string[] = ['소상공인', '창업벤처'];

// 공고명 앞 [지역] 표시와 소관기관 이름으로 서울 밖 공고를 뺀다.
const OTHER_REGION_TAGS: readonly string[] = [
  '부산',
  '대구',
  '인천',
  '광주',
  '대전',
  '울산',
  '세종',
  '경기',
  '강원',
  '충북',
  '충남',
  '전북',
  '전남',
  '경북',
  '경남',
  '제주',
];
const OTHER_REGION_INSTITUTION_PREFIXES: readonly string[] = [
  '부산광역시',
  '대구광역시',
  '인천광역시',
  '광주광역시',
  '대전광역시',
  '울산광역시',
  '세종특별자치시',
  '경기도',
  '강원특별자치도',
  '강원도',
  '충청북도',
  '충청남도',
  '전북특별자치도',
  '전라북도',
  '전라남도',
  '경상북도',
  '경상남도',
  '제주특별자치도',
];

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
});

type BizinfoItem = z.infer<typeof bizinfoItemSchema>;

export type BizinfoSkipCounts = {
  // 지원대상 태그에 소상공인·창업벤처가 없는 공고.
  notTarget: number;
  // 서울 밖 지역 공고.
  otherRegion: number;
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
};

class RetryableBizinfoError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

// 공고명·기관명에 남은 HTML 엔티티를 풀고 공백을 하나로 줄인다.
function cleanText(value: string): string {
  return value
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X'))
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
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

export type BizinfoRegion =
  | { scope: 'SEOUL'; districtCodes: []; basis: string }
  | { scope: 'DISTRICTS'; districtCodes: [string]; basis: string }
  | { scope: 'UNKNOWN' }
  | { scope: 'OTHER' };

function seoulDistrictCode(value: string): string | null {
  const match = /^서울(?:특별시)?\s*(\S+?구)/.exec(value);
  if (!match) return null;
  return SEOUL_DISTRICTS.find((district) => district.name === match[1])?.code ?? null;
}

// 공고명 앞 [지역] 표시가 있으면 그것으로, 없으면 소관기관 이름으로 지역을 정한다. 서울도 다른
// 시·도도 아니면 전국으로 추측하지 않고 미확인으로 둔다.
export function bizinfoRegion(name: string, institution: string): BizinfoRegion {
  const tag = /^\s*\[([^\]]+)\]/.exec(name)?.[1].trim() ?? null;
  if (tag !== null) {
    const districtCode = seoulDistrictCode(tag);
    if (districtCode !== null)
      return { scope: 'DISTRICTS', districtCodes: [districtCode], basis: `공고명 지역 표시 '[${tag}]'` };
    if (tag.startsWith('서울')) {
      const institutionDistrict = seoulDistrictCode(institution);
      if (institutionDistrict !== null) {
        return { scope: 'DISTRICTS', districtCodes: [institutionDistrict], basis: `소관기관 '${institution}'` };
      }
      return { scope: 'SEOUL', districtCodes: [], basis: `공고명 지역 표시 '[${tag}]'` };
    }
    const firstWord = tag.split(/[\s·,]/)[0];
    if (
      OTHER_REGION_TAGS.includes(firstWord) ||
      OTHER_REGION_INSTITUTION_PREFIXES.some((prefix) => tag.startsWith(prefix))
    ) {
      return { scope: 'OTHER' };
    }
  }
  const institutionDistrict = seoulDistrictCode(institution);
  if (institutionDistrict !== null) {
    return { scope: 'DISTRICTS', districtCodes: [institutionDistrict], basis: `소관기관 '${institution}'` };
  }
  if (institution.startsWith('서울')) return { scope: 'SEOUL', districtCodes: [], basis: `소관기관 '${institution}'` };
  if (OTHER_REGION_INSTITUTION_PREFIXES.some((prefix) => institution.startsWith(prefix))) return { scope: 'OTHER' };
  return { scope: 'UNKNOWN' };
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

// 기업마당 응답의 공고를 카탈로그 상품으로 바꾼다. 원문이 주지 않는 사업 단계·지원 유형·용도·업종은
// 추측하지 않고 미확인으로 남긴다. 판정 기준일에 이미 끝난 공고는 올리지 않는다.
export function mapBizinfoItems(
  items: readonly unknown[],
  context: { asOfDate: string; responseChecksum: string },
): BizinfoMapping {
  const skipped: BizinfoSkipCounts = { notTarget: 0, otherRegion: 0, ended: 0, malformed: 0, duplicate: 0 };
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
    const jurisdiction = cleanText(item.jrsdInsttNm);
    const region = bizinfoRegion(name, jurisdiction);
    if (region.scope === 'OTHER') {
      skipped.otherRegion += 1;
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
    if (region.scope === 'SEOUL' || region.scope === 'DISTRICTS') {
      evidence.push({
        ...evidenceBase,
        id: 'bizinfo-region',
        subject: 'REGION',
        summary: `지역 근거: ${region.basis}`,
      });
    }

    products.push({
      productKey,
      name: name.length > 200 ? `${name.slice(0, 199)}…` : name,
      organization,
      supportType: 'UNKNOWN',
      eligibleBusinessStages: [],
      region:
        region.scope === 'UNKNOWN'
          ? {
              scope: 'UNKNOWN',
              districtCodes: [],
              note: '기업마당 공고에서 대상 지역을 확인하지 못했습니다. 원 공고에서 확인해야 합니다.',
            }
          : { scope: region.scope, districtCodes: [...region.districtCodes], note: null },
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
    async collect({ asOfDate, log }): Promise<FundingSourceCollection> {
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
            `기업마당: 공고 ${items.length}건 중 ${mapping.products.length}건을 추가 확인 후보로 만들었습니다(대상 아님 ${skipped.notTarget}건, 서울 밖 ${skipped.otherRegion}건, 신청 종료 ${skipped.ended}건, 형식 오류 ${skipped.malformed}건, 중복 ${skipped.duplicate}건).`,
          ),
        );
        return { products: mapping.products, fetchedCount: items.length, responseChecksum };
      } catch (error) {
        throw new Error(mask(error instanceof Error ? error.message : String(error)));
      }
    },
  };
}

// fetch가 응답을 받기 전에 실패한 경우(연결·시간 초과)만 다시 시도한다.
function isNetworkError(error: Error): boolean {
  return error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError';
}
