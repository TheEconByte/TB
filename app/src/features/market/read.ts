import type { PrismaClient } from '../../generated/prisma/client.ts';
import {
  INDICATOR_DEFINITIONS,
  MARKET_LIMITATIONS,
  type AreaInfo,
  type IndustryInfo,
  type MarketAreaList,
  type MarketSummary,
  type QuarterIndicatorRow,
  type ReleaseInfo,
} from './types.ts';
import { isAreaCode, isDistrictCode, isIndustryCode } from './validation.ts';
import { compareQuarters, quarterLabel } from './quarter.ts';
import { salesBreakdownSchema } from './schema.ts';

export type ReleaseRecord = {
  id: string;
  releaseKey: string;
  label: string;
  basisPeriod: string;
  basisPeriodLabel: string;
  retrievedAt: Date;
  activatedAt: Date | null;
  schemaVersion: string;
  definitionVersion: string;
  sourceUrl: string;
  areaCount: number;
  quarterlyRowCount: number;
  files: unknown;
};

type SourceFileEntry = {
  file?: unknown;
  datasetId?: unknown;
  datasetName?: unknown;
  url?: unknown;
  basisPeriod?: unknown;
  sha256?: unknown;
};

function readSources(files: unknown): ReleaseInfo['sources'] {
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry: SourceFileEntry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { datasetId, datasetName, url, basisPeriod, file, sha256 } = entry as Record<string, unknown>;
    if (typeof file !== 'string' || typeof sha256 !== 'string') return [];
    return [
      {
        datasetId: typeof datasetId === 'string' ? datasetId : '',
        datasetName: typeof datasetName === 'string' ? datasetName : '',
        url: typeof url === 'string' ? url : '',
        basisPeriod: typeof basisPeriod === 'string' ? basisPeriod : '',
        fileName: file,
        sha256,
      },
    ];
  });
}

export function toReleaseInfo(release: ReleaseRecord): ReleaseInfo {
  return {
    releaseKey: release.releaseKey,
    label: release.label,
    basisPeriod: release.basisPeriod,
    basisPeriodLabel: release.basisPeriodLabel,
    retrievedAt: release.retrievedAt.toISOString(),
    activatedAt: release.activatedAt ? release.activatedAt.toISOString() : null,
    schemaVersion: release.schemaVersion,
    definitionVersion: release.definitionVersion,
    sourceUrl: release.sourceUrl,
    areaCount: release.areaCount,
    quarterlyRowCount: release.quarterlyRowCount,
    sources: readSources(release.files),
  };
}

// Only an ACTIVE release is ever served; PENDING, FAILED and SUPERSEDED data is
// invisible to the public API.
export async function findActiveRelease(prisma: PrismaClient): Promise<ReleaseRecord | null> {
  const release = await prisma.marketRelease.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { activatedAt: 'desc' },
    select: {
      id: true,
      releaseKey: true,
      label: true,
      basisPeriod: true,
      basisPeriodLabel: true,
      retrievedAt: true,
      activatedAt: true,
      schemaVersion: true,
      definitionVersion: true,
      sourceUrl: true,
      areaCount: true,
      quarterlyRowCount: true,
      files: true,
    },
  });
  return release ?? null;
}

export async function listSupportedIndustries(
  prisma: PrismaClient,
): Promise<{ activeRelease: ReleaseInfo | null; industries: IndustryInfo[] }> {
  const release = await findActiveRelease(prisma);
  const industries = release
    ? await prisma.industry.findMany({ where: { releaseId: release.id, isSupported: true }, orderBy: { code: 'asc' } })
    : [];
  return {
    activeRelease: release ? toReleaseInfo(release) : null,
    industries: industries.map((industry) => ({
      code: industry.code,
      sourceName: industry.sourceName,
      displayName: industry.displayName,
      displayNameSource: industry.displayNameSource as IndustryInfo['displayNameSource'],
      sourceCategoryVersion: industry.sourceCategoryVersion,
    })),
  };
}

export type AreaListOutcome =
  | { kind: 'OK'; payload: MarketAreaList }
  | { kind: 'RELEASE_UNAVAILABLE' }
  | { kind: 'INVALID_DISTRICT_CODE'; districtCode: string };

export async function listMarketAreas(prisma: PrismaClient, districtCode: string | null): Promise<AreaListOutcome> {
  const release = await findActiveRelease(prisma);
  if (!release) return { kind: 'RELEASE_UNAVAILABLE' };
  if (districtCode !== null && !isDistrictCode(districtCode)) {
    return { kind: 'INVALID_DISTRICT_CODE', districtCode };
  }

  const grouped = await prisma.marketArea.groupBy({
    by: ['districtCode', 'districtName'],
    where: { releaseId: release.id },
    _count: { _all: true },
    orderBy: { districtCode: 'asc' },
  });
  const districts = grouped.map((row) => ({
    districtCode: row.districtCode,
    districtName: row.districtName,
    areaCount: row._count._all,
  }));
  if (districtCode !== null && !districts.some((district) => district.districtCode === districtCode)) {
    return { kind: 'INVALID_DISTRICT_CODE', districtCode };
  }

  const areas =
    districtCode === null
      ? []
      : await prisma.marketArea.findMany({
          where: { releaseId: release.id, districtCode },
          orderBy: [{ areaType: 'asc' }, { areaCode: 'asc' }],
        });

  return {
    kind: 'OK',
    payload: {
      release: toReleaseInfo(release),
      districts,
      areas: areas.map(toAreaInfo),
      filter: { districtCode },
      limitations: MARKET_LIMITATIONS,
    },
  };
}

type AreaRow = {
  areaType: string;
  areaCode: string;
  sourceName: string;
  observedName: string | null;
  areaTypeName: string;
  districtCode: string;
  districtName: string;
};

// Display name priority for an area: the 영역-상권 attribute file names the
// selection list, so it wins; the name observed in the sales/store files is kept
// separately and surfaced when it differs.
export function toAreaInfo(area: AreaRow): AreaInfo {
  return {
    areaType: area.areaType,
    areaCode: area.areaCode,
    displayName: area.sourceName,
    displayNameSource: 'AREA_FILE',
    sourceName: area.sourceName,
    observedName: area.observedName,
    nameMismatch: area.observedName !== null && area.observedName !== area.sourceName,
    areaTypeName: area.areaTypeName,
    districtCode: area.districtCode,
    districtName: area.districtName,
  };
}

export type SummaryOutcome =
  | { kind: 'OK'; payload: MarketSummary }
  | { kind: 'RELEASE_UNAVAILABLE' }
  | { kind: 'INVALID_AREA_CODE'; areaCode: string }
  | { kind: 'AREA_NOT_FOUND'; areaCode: string }
  | { kind: 'AMBIGUOUS_AREA_CODE'; areaCode: string; areaTypes: string[] }
  | { kind: 'INVALID_INDUSTRY_CODE'; industryCode: string }
  | { kind: 'UNSUPPORTED_INDUSTRY'; industryCode: string };

export async function getMarketSummary(
  prisma: PrismaClient,
  params: Readonly<{ areaCode: string; industryCode: string; areaType?: string | undefined }>,
): Promise<SummaryOutcome> {
  const release = await findActiveRelease(prisma);
  if (!release) return { kind: 'RELEASE_UNAVAILABLE' };
  if (!isAreaCode(params.areaCode)) return { kind: 'INVALID_AREA_CODE', areaCode: params.areaCode };
  if (!isIndustryCode(params.industryCode)) return { kind: 'INVALID_INDUSTRY_CODE', industryCode: params.industryCode };

  const candidates = await prisma.marketArea.findMany({
    where: {
      releaseId: release.id,
      areaCode: params.areaCode,
      ...(params.areaType === undefined ? {} : { areaType: params.areaType }),
    },
    orderBy: { areaType: 'asc' },
  });
  if (candidates.length === 0) return { kind: 'AREA_NOT_FOUND', areaCode: params.areaCode };
  if (candidates.length > 1) {
    return {
      kind: 'AMBIGUOUS_AREA_CODE',
      areaCode: params.areaCode,
      areaTypes: candidates.map((area) => area.areaType),
    };
  }
  const area = candidates[0];

  const industry = await prisma.industry.findUnique({
    where: { releaseId_code: { releaseId: release.id, code: params.industryCode } },
  });
  if (!industry) return { kind: 'INVALID_INDUSTRY_CODE', industryCode: params.industryCode };
  if (!industry.isSupported) return { kind: 'UNSUPPORTED_INDUSTRY', industryCode: params.industryCode };

  const rows = await prisma.marketQuarterly.findMany({
    where: {
      releaseId: release.id,
      areaType: area.areaType,
      areaCode: area.areaCode,
      industryCode: params.industryCode,
    },
    orderBy: { quarter: 'asc' },
  });
  rows.sort((left, right) => compareQuarters(left.quarter, right.quarter));

  const quarters: QuarterIndicatorRow[] = rows.map((row) => ({
    quarter: row.quarter,
    label: quarterLabel(row.quarter),
    salesAmount: row.salesAmount === null ? null : row.salesAmount.toFixed(0),
    salesCount: row.salesCount === null ? null : row.salesCount.toFixed(0),
    salesBreakdown: (() => {
      const parsed = salesBreakdownSchema.safeParse(row.salesBreakdownJson);
      return parsed.success ? parsed.data : null;
    })(),
    salesStatus: row.salesAmount === null ? 'NOT_PROVIDED' : 'OBSERVED',
    storeCount: row.storeCount,
    similarIndustryStoreCount: row.similarIndustryStoreCount,
    franchiseStoreCount: row.franchiseStoreCount,
    openedStoreCount: row.openedStoreCount,
    closedStoreCount: row.closedStoreCount,
  }));

  const missingSales = quarters.filter((quarter) => quarter.salesStatus === 'NOT_PROVIDED').length;
  const dataStatus = quarters.length === 0 ? 'NOT_PROVIDED' : missingSales === 0 ? 'AVAILABLE' : 'PARTIAL';
  const dataStatusMessage =
    dataStatus === 'NOT_PROVIDED'
      ? '이 상권·업종 조합의 관측 자료가 없습니다. 0이 아니라 자료 부족입니다.'
      : dataStatus === 'PARTIAL'
        ? `매출 원값이 제공되지 않은 분기가 ${missingSales}개 있습니다. 0이 아니라 자료 부족입니다.`
        : null;

  return {
    kind: 'OK',
    payload: {
      release: toReleaseInfo(release),
      area: toAreaInfo(area),
      industry: {
        code: industry.code,
        sourceName: industry.sourceName,
        displayName: industry.displayName,
        displayNameSource: industry.displayNameSource as IndustryInfo['displayNameSource'],
        sourceCategoryVersion: industry.sourceCategoryVersion,
      },
      availableQuarters: quarters.map((quarter) => ({ quarter: quarter.quarter, label: quarter.label })),
      quarters,
      dataStatus,
      dataStatusMessage,
      indicators: INDICATOR_DEFINITIONS,
      limitations: MARKET_LIMITATIONS,
    },
  };
}
