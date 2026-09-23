import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../market/checksum.ts';
import { canonicalRowsHash } from '../market/seoul-api.ts';
import { createFtcApiClient, FranchiseError, type FetchLike, type FtcRow } from './ftc-api.ts';
import {
  FRANCHISE_DEFAULT_YEAR_COUNT,
  FRANCHISE_INDUSTRY_LARGE,
  FRANCHISE_SCHEMA_VERSION,
  FRANCHISE_SOURCE_URL,
  FTC_SERVICES,
  INDUSTRY_MIDDLE_TO_MARKET,
  type FranchiseBrandRecord,
  type FranchiseSourceRecord,
  type FtcService,
} from './types.ts';

export { FranchiseError } from './ftc-api.ts';

export type FranchiseCheck = { name: string; detail: string };

export type ParsedFranchiseSources = {
  releaseKey: string;
  years: number[];
  retrievedAt: Date;
  startupCostsIncluded: boolean;
  records: FranchiseBrandRecord[];
  sourceTables: FranchiseSourceRecord[];
  checks: FranchiseCheck[];
};

export type ReadFranchiseOptions = {
  serviceKey: string;
  latestYear?: number;
  yearCount?: number;
  includeStartupCosts?: boolean;
  fetchImpl?: FetchLike;
  pageSize?: number;
  concurrency?: number;
  retryDelayMs?: number;
  now?: Date;
  log?: (message: string) => void;
};

type ParsedRow = {
  key: string;
  year: number;
  corpName: string;
  brandName: string;
  industryLarge: string;
  industryMiddle: string;
  amounts: Record<string, number>;
};

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function rowKey(year: number, corpName: string, brandName: string, industryMiddle: string): string {
  return JSON.stringify([year, corpName, brandName, industryMiddle]);
}

// 정보공개서 기준년도의 자료는 그 전년도 실적이다. 진행 중인 연도는 자료가 불완전하므로
// 기본 최신 연도는 한국 시간 기준 올해의 전년도다.
export function defaultLatestYear(now: Date): number {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear() - 1;
}

function invalidRow(label: string, index: number, reason: string): never {
  throw new FranchiseError('INVALID_ROW', `${label} ${index + 1}번째 행: ${reason}`);
}

// 필드 구성·연도·이름·숫자를 검사하고 제품 범위(외식 한식·커피·음료) 행만 돌려준다.
export function parseFtcRows(service: FtcService, year: number, rows: readonly FtcRow[]): ParsedRow[] {
  const label = `${service.name} ${year}`;
  const expected = new Set(service.fields);
  const parsed: ParsedRow[] = [];
  const keys = new Set<string>();
  rows.forEach((row, index) => {
    const actual = Object.keys(row);
    const missing = service.fields.filter((field) => !(field in row));
    const unexpected = actual.filter((field) => !expected.has(field));
    if (missing.length > 0 || unexpected.length > 0)
      throw new FranchiseError(
        'FIELD_MISMATCH',
        `${label} ${index + 1}번째 행의 필드 구성이 기록과 다릅니다(누락: ${missing.join(', ') || '없음'}, 추가: ${unexpected.join(', ') || '없음'}).`,
      );
    if (text(row.yr) !== String(year))
      invalidRow(label, index, `기준년도 '${text(row.yr)}'가 요청한 ${year}와 다릅니다.`);
    const corpName = text(row.corpNm);
    const brandName = text(row.brandNm);
    const industryLarge = text(row.indutyLclasNm);
    const industryMiddle = text(row.indutyMlsfcNm);
    if (!corpName || !brandName || !industryLarge || !industryMiddle)
      invalidRow(label, index, '법인명·브랜드명·업종 이름이 비어 있습니다.');
    const amounts: Record<string, number> = {};
    for (const field of service.amountFields) {
      const value = typeof row[field] === 'string' && row[field] !== '' ? Number(row[field]) : row[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        invalidRow(label, index, `${field} 값 '${String(row[field])}'이 0 이상의 정수가 아닙니다.`);
      amounts[field] = value;
    }
    if (industryLarge !== FRANCHISE_INDUSTRY_LARGE || !(industryMiddle in INDUSTRY_MIDDLE_TO_MARKET)) return;
    const key = rowKey(year, corpName, brandName, industryMiddle);
    if (keys.has(key)) throw new FranchiseError('DUPLICATE_KEY', `${label}: 중복 브랜드 행 ${key}`);
    keys.add(key);
    parsed.push({ key, year, corpName, brandName, industryLarge, industryMiddle, amounts });
  });
  return parsed;
}

// 원본은 평균매출을 공개하지 않으면 0으로 준다. 가맹점이 있는 브랜드의 연 평균매출이 0일 수는
// 없으므로 0은 미기재(NULL)로 저장한다.
function disclosedAmount(value: number): string | null {
  return value === 0 ? null : String(value);
}

type StartupCosts = Pick<
  FranchiseBrandRecord,
  'franchiseFeeThousand' | 'educationFeeThousand' | 'depositThousand' | 'otherCostThousand' | 'startupTotalThousand'
>;

// 다섯 금액이 모두 0이면 미기재로 본다. 하나라도 있으면 개별 0은 실제 0(받지 않는 항목)으로 둔다.
function startupCosts(amounts: Record<string, number>): StartupCosts | null {
  const values = FTC_SERVICES.startupCosts.amountFields.map((field) => amounts[field]);
  if (values.every((value) => value === 0)) return null;
  return {
    franchiseFeeThousand: String(amounts.jngBzmnJngAmt),
    educationFeeThousand: String(amounts.jngBzmnEduAmt),
    depositThousand: String(amounts.jngBzmnAssrncAmt),
    otherCostThousand: String(amounts.jngBzmnEtcAmt),
    startupTotalThousand: String(amounts.smtnAmt),
  };
}

export async function readFranchiseSources(options: ReadFranchiseOptions): Promise<ParsedFranchiseSources> {
  const log = options.log ?? (() => {});
  const retrievedAt = options.now ?? new Date();
  const latestYear = options.latestYear ?? defaultLatestYear(retrievedAt);
  const yearCount = options.yearCount ?? FRANCHISE_DEFAULT_YEAR_COUNT;
  const includeStartupCosts = options.includeStartupCosts ?? true;
  const years = Array.from({ length: yearCount }, (_, index) => latestYear - yearCount + 1 + index);
  const client = createFtcApiClient({
    serviceKey: options.serviceKey,
    fetchImpl: options.fetchImpl,
    pageSize: options.pageSize,
    concurrency: options.concurrency,
    retryDelayMs: options.retryDelayMs,
  });

  const sourceTables: FranchiseSourceRecord[] = [];
  const records: FranchiseBrandRecord[] = [];
  let unmatchedCosts = 0;
  let matchedCosts = 0;
  let undisclosedSales = 0;
  for (const year of years) {
    const services = includeStartupCosts ? [FTC_SERVICES.stores, FTC_SERVICES.startupCosts] : [FTC_SERVICES.stores];
    const byService = new Map<FtcService['key'], ParsedRow[]>();
    for (const service of services) {
      const result = await client.fetchYear(service.path, service.name, year);
      if (result.total === 0)
        throw new FranchiseError(
          'EMPTY_SOURCE',
          `${service.name} ${year}년 자료가 없습니다. 최신 연도를 확인해 주세요.`,
        );
      const parsed = parseFtcRows(service, year, result.rows);
      log(`${service.name} ${year}: ${result.total}행 중 제품 범위 ${parsed.length}건`);
      byService.set(service.key, parsed);
      sourceTables.push({
        service: service.key,
        name: service.name,
        year,
        totalRows: result.total,
        scopeRows: parsed.length,
        sha256: canonicalRowsHash(result.rows, service.fields),
      });
    }
    const stores = byService.get('stores') ?? [];
    if (stores.length === 0) throw new FranchiseError('EMPTY_SOURCE', `${year}년 한식·커피·음료 브랜드가 없습니다.`);
    const costs = new Map((byService.get('startupCosts') ?? []).map((row) => [row.key, row]));
    for (const row of stores) {
      const cost = costs.get(row.key);
      if (cost) {
        matchedCosts += 1;
        costs.delete(row.key);
      }
      const costValues = cost ? startupCosts(cost.amounts) : null;
      const averageSales = disclosedAmount(row.amounts.avrgSlsAmt);
      if (averageSales === null && row.amounts.frcsCnt > 0) undisclosedSales += 1;
      records.push({
        disclosureYear: year,
        corpName: row.corpName,
        brandName: row.brandName,
        industryLarge: row.industryLarge,
        industryMiddle: row.industryMiddle,
        marketIndustryCode: INDUSTRY_MIDDLE_TO_MARKET[row.industryMiddle],
        storeCount: row.amounts.frcsCnt,
        newStoreCount: row.amounts.newFrcsRgsCnt,
        contractEndCount: row.amounts.ctrtEndCnt,
        contractCancelCount: row.amounts.ctrtCncltnCnt,
        ownershipChangeCount: row.amounts.nmChgCnt,
        averageSalesThousand: averageSales,
        averageSalesPerAreaThousand: disclosedAmount(row.amounts.arUnitAvrgSlsAmt),
        franchiseFeeThousand: costValues?.franchiseFeeThousand ?? null,
        educationFeeThousand: costValues?.educationFeeThousand ?? null,
        depositThousand: costValues?.depositThousand ?? null,
        otherCostThousand: costValues?.otherCostThousand ?? null,
        startupTotalThousand: costValues?.startupTotalThousand ?? null,
      });
    }
    unmatchedCosts += costs.size;
  }

  const lines = records.map((record) => JSON.stringify(Object.values(record)));
  lines.sort();
  const contentHash = sha256Hex(lines.join('\n'));
  const checks: FranchiseCheck[] = [
    { name: '연도별 자료', detail: `${years.join('·')}년 모두 한식·커피·음료 브랜드가 있습니다.` },
    { name: '중복 키 0', detail: `브랜드 ${records.length}건의 연도·법인·브랜드·업종 키가 모두 다릅니다.` },
    {
      name: '평균매출 미기재',
      detail: `가맹점이 있으나 평균매출이 0으로 온 ${undisclosedSales}건을 미기재로 저장했습니다.`,
    },
    includeStartupCosts
      ? {
          name: '창업 금액 연결',
          detail: `${matchedCosts}건을 연결했고 짝이 없는 창업 금액 행은 ${unmatchedCosts}건입니다.`,
        }
      : { name: '창업 금액 연결', detail: '운영자가 창업 금액을 빼고 적재했습니다.' },
  ];
  return {
    releaseKey: `ftc-franchise-${years[0]}-${years[years.length - 1]}-${includeStartupCosts ? '' : 'nocost-'}${contentHash.slice(0, 12)}`,
    years,
    retrievedAt,
    startupCostsIncluded: includeStartupCosts,
    records,
    sourceTables,
    checks,
  };
}

export type FranchiseLoadReport = {
  outcome: 'ACTIVATED' | 'ALREADY_ACTIVE';
  releaseKey: string;
  years: number[];
  brandCount: number;
  startupCostsIncluded: boolean;
  checks: FranchiseCheck[];
};

async function markFailed(prisma: PrismaClient, releaseId: string, error: unknown) {
  await prisma.franchiseBrandStat.deleteMany({ where: { releaseId } });
  await prisma.franchiseRelease.update({
    where: { id: releaseId },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      failureReason: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    },
  });
}

export async function loadFranchises(
  options: ReadFranchiseOptions & { prisma: PrismaClient },
): Promise<FranchiseLoadReport> {
  const parsed = await readFranchiseSources(options);
  const { prisma } = options;
  const base = {
    releaseKey: parsed.releaseKey,
    years: parsed.years,
    brandCount: parsed.records.length,
    startupCostsIncluded: parsed.startupCostsIncluded,
    checks: parsed.checks,
  };
  const existing = await prisma.franchiseRelease.findUnique({ where: { releaseKey: parsed.releaseKey } });
  if (existing?.status === 'ACTIVE') return { outcome: 'ALREADY_ACTIVE', ...base };
  if (existing) await prisma.franchiseRelease.delete({ where: { id: existing.id } });
  const release = await prisma.franchiseRelease.create({
    data: {
      releaseKey: parsed.releaseKey,
      schemaVersion: FRANCHISE_SCHEMA_VERSION,
      sourceUrl: FRANCHISE_SOURCE_URL,
      basisYears: `${parsed.years[0]}-${parsed.years[parsed.years.length - 1]}`,
      retrievedAt: parsed.retrievedAt,
      startupCostsIncluded: parsed.startupCostsIncluded,
      sourceTables: parsed.sourceTables as unknown as Prisma.InputJsonValue,
      validationSummary: { checks: parsed.checks } as unknown as Prisma.InputJsonValue,
      brandCount: parsed.records.length,
    },
  });
  try {
    const chunkSize = 2000;
    for (let index = 0; index < parsed.records.length; index += chunkSize) {
      await prisma.franchiseBrandStat.createMany({
        data: parsed.records.slice(index, index + chunkSize).map((record) => ({ ...record, releaseId: release.id })),
      });
    }
    const persisted = await prisma.franchiseBrandStat.count({ where: { releaseId: release.id } });
    if (persisted !== parsed.records.length)
      throw new FranchiseError(
        'DB_VERIFICATION',
        `적재 ${persisted}건이 검증값 ${parsed.records.length}건과 다릅니다.`,
      );
    await prisma.$transaction([
      prisma.franchiseRelease.updateMany({
        where: { status: 'ACTIVE', id: { not: release.id } },
        data: { status: 'SUPERSEDED' },
      }),
      prisma.franchiseRelease.update({
        where: { id: release.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      }),
    ]);
  } catch (error) {
    await markFailed(prisma, release.id, error);
    throw error;
  }
  return { outcome: 'ACTIVATED', ...base };
}
