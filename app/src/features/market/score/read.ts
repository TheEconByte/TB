import type { PrismaClient } from '../../../generated/prisma/client.ts';
import { compareQuarters } from '../quarter.ts';
import { findActiveRelease } from '../read.ts';
import type { AreaSeries, QuarterObservation } from './dataset.ts';

export type ScoreSeriesData = {
  releaseId: string;
  releaseKey: string;
  // 오래된 순
  quarters: string[];
  seriesByIndustry: Map<string, AreaSeries[]>;
};

// ACTIVE 상권 릴리스에서 업종별 상권 시계열을 읽는다. 점포 수는 유사_업종_점포_수다.
export async function loadScoreSeries(
  prisma: PrismaClient,
  industryCodes: readonly string[],
): Promise<ScoreSeriesData> {
  const release = await findActiveRelease(prisma);
  if (!release) throw new Error('ACTIVE 상권 릴리스가 없습니다. market:load를 먼저 실행하세요.');
  const rows = await prisma.marketQuarterly.findMany({
    where: { releaseId: release.id, industryCode: { in: [...industryCodes] } },
    select: {
      quarter: true,
      areaType: true,
      areaCode: true,
      industryCode: true,
      salesAmount: true,
      similarIndustryStoreCount: true,
      closedStoreCount: true,
      openedStoreCount: true,
      franchiseStoreCount: true,
    },
  });

  const quarters = new Set<string>();
  const byKey = new Map<string, AreaSeries & { byQuarter: Map<string, QuarterObservation> }>();
  for (const row of rows) {
    quarters.add(row.quarter);
    const key = `${row.industryCode}|${row.areaType}|${row.areaCode}`;
    let series = byKey.get(key);
    if (!series) {
      series = { areaType: row.areaType, areaCode: row.areaCode, industryCode: row.industryCode, byQuarter: new Map() };
      byKey.set(key, series);
    }
    series.byQuarter.set(row.quarter, {
      salesAmount: row.salesAmount === null ? null : row.salesAmount.toFixed(0),
      storeCount: row.similarIndustryStoreCount,
      closedStoreCount: row.closedStoreCount,
      openedStoreCount: row.openedStoreCount,
      franchiseStoreCount: row.franchiseStoreCount,
    });
  }

  const seriesByIndustry = new Map<string, AreaSeries[]>();
  for (const series of byKey.values()) {
    const list = seriesByIndustry.get(series.industryCode) ?? [];
    list.push(series);
    seriesByIndustry.set(series.industryCode, list);
  }
  return {
    releaseId: release.id,
    releaseKey: release.releaseKey,
    quarters: [...quarters].sort(compareQuarters),
    seriesByIndustry,
  };
}
