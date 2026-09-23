import type { PrismaClient } from '../../generated/prisma/client.ts';
import { SEOUL_DISTRICTS } from '../funding/districts.ts';
import { quarterLabel } from '../market/quarter.ts';
import { percentLabel, wonPerSquareMeter } from './estimate.ts';
import { districtsForRegion, REGION_MAPPING_VERSION } from './regions.ts';
import {
  BUILDING_TYPE_CRITERIA,
  BUILDING_TYPE_LABELS,
  FLOOR_CODES,
  FLOOR_LABELS,
  RENT_BENCHMARK_STAT_NAME,
  type BuildingType,
  type FloorCode,
  type RentBenchmarkPayload,
  type RentRegionBenchmark,
} from './types.ts';

// 권역은 부동산원 표의 순서를 따른다. 목록에 없는 권역은 뒤에 이름순으로 붙인다.
const GROUP_ORDER = ['도심', '강남', '영등포신촌', '기타'];

export type RentBenchmarkOutcome = { kind: 'OK'; payload: RentBenchmarkPayload } | { kind: 'RELEASE_UNAVAILABLE' };

function groupRank(name: string): number {
  const index = GROUP_ORDER.indexOf(name);
  return index === -1 ? GROUP_ORDER.length : index;
}

function compareRegions(left: RentRegionBenchmark, right: RentRegionBenchmark): number {
  if (left.level === 1 || right.level === 1) return left.level - right.level;
  const leftGroup = left.level === 2 ? left.name : (left.groupName ?? '');
  const rightGroup = right.level === 2 ? right.name : (right.groupName ?? '');
  if (leftGroup !== rightGroup)
    return groupRank(leftGroup) - groupRank(rightGroup) || leftGroup.localeCompare(rightGroup, 'ko');
  if (left.level !== right.level) return left.level - right.level;
  return left.name.localeCompare(right.name, 'ko');
}

export async function getRentBenchmarks(
  prisma: PrismaClient,
  input: Readonly<{ buildingType: BuildingType; districtCode: string | null }>,
): Promise<RentBenchmarkOutcome> {
  const release = await prisma.rentBenchmarkRelease.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { activatedAt: 'desc' },
  });
  if (!release) return { kind: 'RELEASE_UNAVAILABLE' };
  const latestQuarter = release.basisPeriod.split('-')[1];
  // 추이는 대표 임대료만, 층별 임대료와 공실률은 최신 분기만 읽는다.
  const rows = await prisma.rentBenchmarkObservation.findMany({
    where: {
      releaseId: release.id,
      buildingType: input.buildingType,
      OR: [{ metric: 'RENT' }, { metric: { in: ['FLOOR_RENT', 'VACANCY_RATE'] }, quarter: latestQuarter }],
    },
    orderBy: [{ regionPath: 'asc' }, { quarter: 'asc' }],
  });

  const regions = new Map<string, RentRegionBenchmark>();
  for (const row of rows) {
    let region = regions.get(row.regionPath);
    if (!region) {
      const parts = row.regionPath.split('>');
      region = {
        path: row.regionPath,
        name: row.regionName,
        level: row.regionLevel,
        groupName: parts.length === 3 ? parts[1] : null,
        districtCodes: districtsForRegion(row.regionPath),
        latest: { rentPerSquareMeterWon: null, sourceValue: null, vacancyRatePercent: null, floors: [] },
        trend: [],
      };
      regions.set(row.regionPath, region);
    }
    const value = row.value === null ? null : row.value.toString();
    if (row.metric === 'RENT') {
      region.trend.push({
        quarter: row.quarter,
        label: quarterLabel(row.quarter),
        rentPerSquareMeterWon: wonPerSquareMeter(value),
      });
      if (row.quarter === latestQuarter) {
        region.latest.rentPerSquareMeterWon = wonPerSquareMeter(value);
        region.latest.sourceValue = value;
      }
    } else if (row.metric === 'VACANCY_RATE') {
      region.latest.vacancyRatePercent = percentLabel(value);
    } else if (row.metric === 'FLOOR_RENT') {
      const floor = row.floor as FloorCode;
      region.latest.floors.push({
        floor,
        label: FLOOR_LABELS[floor] ?? row.floor,
        rentPerSquareMeterWon: wonPerSquareMeter(value),
        sourceValue: value,
      });
    }
  }
  for (const region of regions.values()) {
    region.latest.floors.sort((left, right) => FLOOR_CODES.indexOf(left.floor) - FLOOR_CODES.indexOf(right.floor));
  }
  const ordered = [...regions.values()].sort(compareRegions);
  const label = BUILDING_TYPE_LABELS[input.buildingType];
  const name = SEOUL_DISTRICTS.find((district) => district.code === input.districtCode)?.name ?? null;
  return {
    kind: 'OK',
    payload: {
      source: {
        statName: RENT_BENCHMARK_STAT_NAME,
        sourceUrl: release.sourceUrl,
        releaseKey: release.releaseKey,
        retrievedAt: release.retrievedAt.toISOString(),
        basisPeriodLabel: release.basisPeriodLabel,
        latestQuarter,
        latestQuarterLabel: quarterLabel(latestQuarter),
        sourceUnit: '천원/㎡',
      },
      buildingType: { code: input.buildingType, label, criteria: BUILDING_TYPE_CRITERIA[input.buildingType] },
      district:
        input.districtCode && name
          ? {
              code: input.districtCode,
              name,
              regionPaths: ordered
                .filter((region) => region.districtCodes.includes(input.districtCode ?? ''))
                .map((region) => region.path),
            }
          : null,
      regionMappingVersion: REGION_MAPPING_VERSION,
      regions: ordered,
      definitions: [
        '임대료는 (보증금 × 전환율 ÷ 12 + 월 임대료) ÷ 임대 면적(전용+공용)으로 계산한 ㎡당 월 시장임대료입니다. 관리비는 포함하지 않습니다.',
        '대표 임대료는 1층 기준(1층이 없으면 2층)이고, 층별 임대료는 층마다 따로 조사한 값입니다.',
        `${label}: ${BUILDING_TYPE_CRITERIA[input.buildingType]}.`,
      ],
      limitations: [
        '부동산원 표본 조사의 지역 평균이며 특정 점포의 임대료 시세가 아닙니다.',
        '조사 상권과 자치구의 연결은 상권 이름이 가리키는 위치 기준의 참고용이며 실제 경계와 다를 수 있습니다.',
        '재무계획의 월 임대료에 자동으로 입력하지 않습니다.',
      ],
    },
  };
}
