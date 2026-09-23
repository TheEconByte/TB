import Decimal from 'decimal.js';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import {
  FRANCHISE_SOURCE_NAME,
  FTC_COMPARE_URL,
  INDUSTRY_MIDDLE_TO_MARKET,
  type FranchiseBrand,
  type FranchisePayload,
  type FranchiseYearStats,
  type MarketIndustryCode,
} from './types.ts';

const INDUSTRY_LABELS: Readonly<Record<MarketIndustryCode, string>> = {
  CS100001: '한식',
  CS100010: '커피·음료',
};

export type FranchiseOutcome = { kind: 'OK'; payload: FranchisePayload } | { kind: 'RELEASE_UNAVAILABLE' };

type StatRow = Awaited<ReturnType<PrismaClient['franchiseBrandStat']['findMany']>>[number];

// 원본 금액은 천원 단위 정수다. 원 단위 정수 문자열로 바꾼다.
function won(value: { toString(): string } | null): string | null {
  return value === null ? null : new Decimal(value.toString()).times(1000).toFixed(0);
}

function yearStats(row: StatRow, startupCostsIncluded: boolean): FranchiseYearStats {
  const averageSalesWon = won(row.averageSalesThousand);
  const statusReported =
    row.storeCount > 0 ||
    row.newStoreCount > 0 ||
    row.contractEndCount > 0 ||
    row.contractCancelCount > 0 ||
    row.ownershipChangeCount > 0 ||
    row.averageSalesThousand !== null ||
    row.averageSalesPerAreaThousand !== null;
  return {
    disclosureYear: row.disclosureYear,
    performanceYear: row.disclosureYear - 1,
    statusReported,
    storeCount: row.storeCount,
    newStoreCount: row.newStoreCount,
    contractEndCount: row.contractEndCount,
    contractCancelCount: row.contractCancelCount,
    ownershipChangeCount: row.ownershipChangeCount,
    averageSalesWon,
    averageSalesPerAreaWon: won(row.averageSalesPerAreaThousand),
    averageMonthlySalesWon:
      averageSalesWon === null
        ? null
        : new Decimal(averageSalesWon).div(12).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
    startupCosts: startupCostsIncluded
      ? {
          franchiseFeeWon: won(row.franchiseFeeThousand),
          educationFeeWon: won(row.educationFeeThousand),
          depositWon: won(row.depositThousand),
          otherCostWon: won(row.otherCostThousand),
          totalWon: won(row.startupTotalThousand),
        }
      : null,
  };
}

function brandKey(row: Pick<StatRow, 'corpName' | 'brandName' | 'industryMiddle'>): string {
  return JSON.stringify([row.corpName, row.brandName, row.industryMiddle]);
}

export async function getFranchises(
  prisma: PrismaClient,
  input: Readonly<{ industryCode: MarketIndustryCode; query: string; limit: number }>,
): Promise<FranchiseOutcome> {
  const release = await prisma.franchiseRelease.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { activatedAt: 'desc' },
  });
  if (!release) return { kind: 'RELEASE_UNAVAILABLE' };
  const latestYear = Number(release.basisYears.split('-')[1]);
  const scope = { releaseId: release.id, marketIndustryCode: input.industryCode, disclosureYear: latestYear };
  const where = input.query
    ? {
        ...scope,
        OR: [
          { brandName: { contains: input.query, mode: 'insensitive' as const } },
          { corpName: { contains: input.query, mode: 'insensitive' as const } },
        ],
      }
    : scope;
  const [latestRows, totalMatches, brandCount, brandsWithStores, brandsWithSales] = await Promise.all([
    prisma.franchiseBrandStat.findMany({
      where,
      orderBy: [{ storeCount: 'desc' }, { brandName: 'asc' }, { corpName: 'asc' }],
      take: input.limit,
    }),
    prisma.franchiseBrandStat.count({ where }),
    prisma.franchiseBrandStat.count({ where: scope }),
    prisma.franchiseBrandStat.count({ where: { ...scope, storeCount: { gt: 0 } } }),
    prisma.franchiseBrandStat.count({ where: { ...scope, averageSalesThousand: { not: null } } }),
  ]);
  // 같은 법인·브랜드·업종의 이전 연도 행을 이어 붙인다. 이름이 바뀐 브랜드는 이어지지 않는다.
  const historyRows =
    latestRows.length === 0
      ? []
      : await prisma.franchiseBrandStat.findMany({
          where: {
            releaseId: release.id,
            OR: latestRows.map((row) => ({
              corpName: row.corpName,
              brandName: row.brandName,
              industryMiddle: row.industryMiddle,
            })),
          },
          orderBy: { disclosureYear: 'asc' },
        });
  const histories = new Map<string, StatRow[]>();
  for (const row of historyRows) {
    const key = brandKey(row);
    histories.set(key, [...(histories.get(key) ?? []), row]);
  }
  const brands: FranchiseBrand[] = latestRows.map((row) => ({
    id: row.id,
    brandName: row.brandName,
    corpName: row.corpName,
    industryMiddle: row.industryMiddle,
    latest: yearStats(row, release.startupCostsIncluded),
    history: (histories.get(brandKey(row)) ?? [row]).map((item) => yearStats(item, release.startupCostsIncluded)),
  }));
  return {
    kind: 'OK',
    payload: {
      source: {
        name: FRANCHISE_SOURCE_NAME,
        sourceUrl: release.sourceUrl,
        compareUrl: FTC_COMPARE_URL,
        releaseKey: release.releaseKey,
        retrievedAt: release.retrievedAt.toISOString(),
        basisYears: release.basisYears,
        latestDisclosureYear: latestYear,
        latestPerformanceYear: latestYear - 1,
        startupCostsIncluded: release.startupCostsIncluded,
      },
      industry: {
        code: input.industryCode,
        label: INDUSTRY_LABELS[input.industryCode],
        ftcMiddleNames: Object.entries(INDUSTRY_MIDDLE_TO_MARKET)
          .filter(([, code]) => code === input.industryCode)
          .map(([name]) => name),
      },
      summary: { brandCount, brandsWithStores, brandsWithSales },
      query: input.query,
      brands,
      totalMatches,
      definitions: [
        `${latestYear}년 정보공개서의 수치는 ${latestYear - 1}년 실적이며, 가맹점 수는 ${latestYear - 1}년 말 기준입니다.`,
        '평균매출은 가맹점사업자의 연간 평균 매출액이고, 면적당 평균매출은 3.3㎡(1평)당 금액입니다. 월 평균은 연 평균매출을 12로 나눈 값입니다.',
        '창업 금액은 정보공개서의 가맹점사업자 부담금(가맹금·교육비·보증금·기타)입니다. 기타에는 인테리어·설비·집기·간판·비품 등이 들어갈 수 있으며, 세부 항목과 기준 점포 면적은 브랜드마다 다릅니다.',
        '가맹본부가 평균매출을 기재하지 않아 원본이 0으로 준 값은 "미기재"로 표시합니다.',
        '가맹점 수·개폐점·평균매출이 모두 0인 해는 신규 브랜드인지 미기재인지 알 수 없어 "현황 없음"으로 표시합니다.',
      ],
      limitations: [
        '가맹본부가 제출한 정보공개서 기준 전국 평균이며, 특정 지역·점포의 예상 매출이 아닙니다.',
        '재무계획의 매출·비용 가정에 자동으로 입력하지 않습니다.',
        '계약 전에는 가맹본부에서 받은 최신 정보공개서와 가맹계약서를 직접 확인해야 합니다.',
      ],
    },
  };
}
