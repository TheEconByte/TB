import type { PrismaClient } from '../../generated/prisma/client.ts';
import { districtName } from '../funding/districts.ts';
import { isMeatCategory } from './mapping.ts';
import type { BusinessCategoryInfo, BusinessDirectoryReleaseInfo, BusinessSummary } from './types.ts';

async function activeRelease(prisma: PrismaClient) {
  return prisma.businessDirectoryRelease.findFirst({ where: { status: 'ACTIVE' }, orderBy: { activatedAt: 'desc' } });
}

function releaseInfo(release: NonNullable<Awaited<ReturnType<typeof activeRelease>>>): BusinessDirectoryReleaseInfo {
  return {
    releaseKey: release.releaseKey,
    schemaVersion: release.schemaVersion,
    sourceUrl: release.sourceUrl,
    retrievedAt: release.retrievedAt.toISOString(),
    activatedAt: release.activatedAt?.toISOString() ?? null,
    sourceChecksum: release.sourceChecksum,
    businessCount: release.businessCount,
  };
}

export async function listBusinessCategories(prisma: PrismaClient): Promise<{
  activeRelease: BusinessDirectoryReleaseInfo | null;
  categories: BusinessCategoryInfo[];
  nullReason: string | null;
}> {
  const release = await activeRelease(prisma);
  if (!release) {
    return {
      activeRelease: null,
      categories: [],
      nullReason: '소진공 상가(상권)정보 스냅샷이 아직 활성화되지 않았습니다.',
    };
  }
  const grouped = await prisma.businessLocation.groupBy({
    by: ['smallCategoryCode', 'smallCategoryName', 'middleCategoryCode', 'middleCategoryName', 'marketIndustryCode'],
    where: { releaseId: release.id, marketIndustryCode: { not: null } },
    _count: { _all: true },
    orderBy: [{ marketIndustryCode: 'asc' }, { smallCategoryName: 'asc' }],
  });
  return {
    activeRelease: releaseInfo(release),
    categories: grouped.flatMap((row) =>
      row.marketIndustryCode === null
        ? []
        : [
            {
              code: row.smallCategoryCode,
              name: row.smallCategoryName,
              middleCode: row.middleCategoryCode,
              middleName: row.middleCategoryName,
              marketIndustryCode: row.marketIndustryCode,
              businessCount: row._count._all,
              meatCategory: isMeatCategory(row.smallCategoryName),
            },
          ],
    ),
    nullReason: null,
  };
}

export type BusinessSummaryOutcome =
  { kind: 'OK'; payload: BusinessSummary } | { kind: 'RELEASE_UNAVAILABLE' } | { kind: 'CATEGORY_NOT_FOUND' };

export async function getBusinessSummary(
  prisma: PrismaClient,
  input: Readonly<{ districtCode: string; detailedIndustryCode: string }>,
): Promise<BusinessSummaryOutcome> {
  const release = await activeRelease(prisma);
  if (!release) return { kind: 'RELEASE_UNAVAILABLE' };
  const categoryGroup = await prisma.businessLocation.groupBy({
    by: ['smallCategoryCode', 'smallCategoryName', 'middleCategoryCode', 'middleCategoryName', 'marketIndustryCode'],
    where: { releaseId: release.id, smallCategoryCode: input.detailedIndustryCode, marketIndustryCode: { not: null } },
    _count: { _all: true },
  });
  const categoryRow = categoryGroup[0];
  if (!categoryRow || categoryRow.marketIndustryCode === null) return { kind: 'CATEGORY_NOT_FOUND' };
  const where = {
    releaseId: release.id,
    districtCode: input.districtCode,
    smallCategoryCode: input.detailedIndustryCode,
  };
  const [businessCount, businesses] = await Promise.all([
    prisma.businessLocation.count({ where }),
    prisma.businessLocation.findMany({
      where,
      orderBy: [{ businessName: 'asc' }, { sourceBusinessId: 'asc' }],
      take: 50,
    }),
  ]);
  const category: BusinessCategoryInfo = {
    code: categoryRow.smallCategoryCode,
    name: categoryRow.smallCategoryName,
    middleCode: categoryRow.middleCategoryCode,
    middleName: categoryRow.middleCategoryName,
    marketIndustryCode: categoryRow.marketIndustryCode,
    businessCount: categoryRow._count._all,
    meatCategory: isMeatCategory(categoryRow.smallCategoryName),
  };
  const name = districtName(input.districtCode) ?? input.districtCode;
  return {
    kind: 'OK',
    payload: {
      competitionScope: {
        kind: 'DETAILED_INDUSTRY',
        code: category.code,
        label: category.name,
        statement: `${name}의 ${category.name} 점포 현황이며 매출·고객 분석 범위가 아닙니다.`,
      },
      observedScope: null,
      sourceRelease: release.releaseKey,
      asOf: release.retrievedAt.toISOString(),
      nullReason: null,
      district: { code: input.districtCode, name },
      category,
      businessCount,
      businesses: businesses.map((business) => ({
        sourceBusinessId: business.sourceBusinessId,
        businessName: business.businessName,
        branchName: business.branchName,
        roadAddress: business.roadAddress,
        lotAddress: business.lotAddress,
        longitude: business.longitude?.toFixed(7) ?? null,
        latitude: business.latitude?.toFixed(7) ?? null,
      })),
      truncated: businessCount > businesses.length,
      limitations: [
        '소진공 상가(상권)정보 API의 점포명·주소·업종 스냅샷입니다.',
        '점포 수는 추정매출이나 영업 성과를 의미하지 않습니다.',
        '서울시 추정매출은 별도의 상위 업종 기준으로 표시합니다.',
      ],
    },
  };
}

export async function resolveDetailedCategory(prisma: PrismaClient, code: string, marketIndustryCode: string) {
  const release = await activeRelease(prisma);
  if (!release) return null;
  const row = await prisma.businessLocation.findFirst({
    where: { releaseId: release.id, smallCategoryCode: code, marketIndustryCode },
    select: { smallCategoryCode: true, smallCategoryName: true },
  });
  return row ? { code: row.smallCategoryCode, name: row.smallCategoryName, releaseKey: release.releaseKey } : null;
}
