import Decimal from 'decimal.js';
import { z } from 'zod';
import type { PrismaClient } from '../../../generated/prisma/client.ts';
import { quarterLabel, basisPeriodLabel } from '../quarter.ts';
import { supportedIndustry } from '../types.ts';
import { isAreaCode, isIndustryCode } from '../validation.ts';
import type { ScoreDetail, ScoreSummary } from './build.ts';
import type { FeatureKey, Grade } from './config.ts';
import type { DisplayUnit } from './dataset.ts';
import { revenueOutlier, topPercent } from './build.ts';
import { marketScoreModelSchema } from './model.ts';

// 공개 점수 API(/api/markets/score)의 응답과 조회. 활성 점수 릴리스만 읽고 웹 요청 중에 계산하지 않는다.

export const MAX_CONTRIBUTIONS = 4;

export const SCORE_LIMITATIONS: readonly string[] = [
  '서울시 상권분석서비스의 공공 추정 데이터로 계산했습니다.',
  '개별 점포의 생존 확률이나 예상매출이 아닙니다. 같은 업종 점포들의 향후 1년 폐업률이 서울 중간 수준보다 낮을 가능성입니다.',
  '서울의 한식·커피 상권만 학습했고, 테스트 정확도가 기준에 못 미친 업종은 점수를 내지 않습니다.',
  '점포당 월매출은 매출 원값을 분기 월평균으로 본 잠정 해석입니다(ADR 0002).',
];

export const marketScoreQuerySchema = z.object({
  areaCode: z.string().trim().min(1).max(20),
  industryCode: z.string().trim().min(1).max(20),
  areaType: z.string().trim().min(1).max(4).optional(),
});

export type MarketScoreStatus = 'OK' | 'INSUFFICIENT_STORES' | 'UNSUPPORTED_INDUSTRY' | 'NO_DATA';

export type ScoreContribution = {
  key: FeatureKey;
  label: string;
  displayLabel: string;
  unit: DisplayUnit;
  // 이 상권의 값과 같은 업종 평균(점수 낸 상권의 산술 평균). 금액은 원 단위 정수 문자열, 비율은 소수 문자열
  value: string;
  average: string;
  // 실제 값으로 정한 높음/낮음과, 기여도 부호로 정한 점수 올림/내림
  comparison: 'HIGHER' | 'LOWER' | 'SAME';
  effect: 'RAISES' | 'LOWERS';
  contribution: number;
};

export type MarketScoreResponse = {
  status: MarketScoreStatus;
  message: string | null;
  area: { areaType: string; areaCode: string; displayName: string; districtCode: string; districtName: string };
  industry: { code: string; displayName: string };
  servedIndustries: { code: string; displayName: string }[];
  baseQuarter: string;
  baseQuarterLabel: string;
  release: { releaseKey: string; modelVersion: string; marketReleaseKey: string; activatedAt: string | null };
  storeCount: number | null;
  score: { value: number; grade: Grade; rank: number; total: number; topPercent: number } | null;
  contributions: ScoreContribution[];
  distribution: { bins: { from: number; to: number; count: number }[]; total: number } | null;
  financeDefault: {
    monthlyRevenue: string;
    provisional: true;
    basis: string;
    salesSum: string;
    storeCountSum: number;
    quarters: string[];
    // 같은 업종 하위·상위 1% 경계 밖이면 방향. 원값은 그대로 두고 화면에 경고만 붙인다.
    unusual: 'HIGH' | 'LOW' | null;
    warningRange: { low: string; high: string } | null;
  } | null;
  model: {
    version: string;
    trainPeriod: string;
    testPeriod: string;
    trainSize: number;
    testSize: number;
    testAuc: number;
    intercept: number;
    coefficients: {
      key: FeatureKey;
      label: string;
      definition: string;
      beta: number;
      standardError: number;
      pValue: number;
    }[];
    gradeBoundaries: { grade: Grade; minScore: number }[];
  } | null;
  limitations: readonly string[];
};

export type MarketScoreOutcome =
  | { kind: 'OK'; payload: MarketScoreResponse }
  | { kind: 'SCORE_UNAVAILABLE' }
  | { kind: 'INVALID_AREA_CODE'; areaCode: string }
  | { kind: 'INVALID_INDUSTRY_CODE'; industryCode: string }
  | { kind: 'AREA_NOT_FOUND'; areaCode: string }
  | { kind: 'AMBIGUOUS_AREA_CODE'; areaCode: string; areaTypes: string[] };

export function scoreStatusMessage(
  status: MarketScoreStatus,
  storeCount: number | null,
  servedNames: readonly string[],
): string | null {
  switch (status) {
    case 'OK':
      return null;
    case 'INSUFFICIENT_STORES':
      return storeCount === 0 || storeCount === null
        ? '이 상권에는 이 업종 점포가 없어 점수를 내지 않습니다.'
        : `점포가 ${storeCount}개뿐이라 점수를 내지 않습니다.`;
    case 'UNSUPPORTED_INDUSTRY':
      return `현재 ${servedNames.join('·')}만 지원합니다.`;
    case 'NO_DATA':
      return '이 상권은 최근 데이터가 없습니다.';
  }
}

export function compareDisplay(value: string, average: string): ScoreContribution['comparison'] {
  const diff = new Decimal(value).comparedTo(new Decimal(average));
  return diff > 0 ? 'HIGHER' : diff < 0 ? 'LOWER' : 'SAME';
}

export function topContributions(
  detail: ScoreDetail,
  averages: ScoreSummary['industries'][number]['featureAverages'],
): ScoreContribution[] {
  return [...detail.features]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, MAX_CONTRIBUTIONS)
    .map((feature) => {
      const average = averages[feature.key] ?? feature.displayValue;
      return {
        key: feature.key,
        label: feature.label,
        displayLabel: feature.displayLabel,
        unit: feature.unit,
        value: feature.displayValue,
        average,
        comparison: compareDisplay(feature.displayValue, average),
        effect: feature.contribution >= 0 ? 'RAISES' : 'LOWERS',
        contribution: feature.contribution,
      };
    });
}

export async function getMarketScore(
  prisma: PrismaClient,
  params: Readonly<{ areaCode: string; industryCode: string; areaType?: string | undefined }>,
): Promise<MarketScoreOutcome> {
  const release = await prisma.marketScoreRelease.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { activatedAt: 'desc' },
  });
  if (!release) return { kind: 'SCORE_UNAVAILABLE' };
  if (!isAreaCode(params.areaCode)) return { kind: 'INVALID_AREA_CODE', areaCode: params.areaCode };
  if (!isIndustryCode(params.industryCode)) return { kind: 'INVALID_INDUSTRY_CODE', industryCode: params.industryCode };

  // 점수를 계산한 상권 릴리스의 영역으로 찾는다. 상권 릴리스가 바뀌어도 점수와 이름이 어긋나지 않는다.
  const candidates = await prisma.marketArea.findMany({
    where: {
      releaseId: release.marketReleaseId,
      areaCode: params.areaCode,
      ...(params.areaType === undefined ? {} : { areaType: params.areaType }),
    },
    orderBy: { areaType: 'asc' },
  });
  if (candidates.length === 0) return { kind: 'AREA_NOT_FOUND', areaCode: params.areaCode };
  if (candidates.length > 1) {
    return { kind: 'AMBIGUOUS_AREA_CODE', areaCode: params.areaCode, areaTypes: candidates.map((a) => a.areaType) };
  }
  const area = candidates[0];
  const summary = release.summaryJson as unknown as ScoreSummary;
  const model = marketScoreModelSchema.parse(release.modelJson);
  const servedIndustries = summary.servedIndustryCodes.map((code) => ({
    code,
    displayName: supportedIndustry(code)?.displayName ?? code,
  }));
  const industrySummary = summary.industries.find((item) => item.industryCode === params.industryCode);
  const industryModel = model.industries.find((item) => item.industryCode === params.industryCode);
  const served = industrySummary?.served === true && industryModel !== undefined;

  const base: Omit<MarketScoreResponse, 'status' | 'message' | 'storeCount'> = {
    area: {
      areaType: area.areaType,
      areaCode: area.areaCode,
      displayName: area.sourceName,
      districtCode: area.districtCode,
      districtName: area.districtName,
    },
    industry: {
      code: params.industryCode,
      displayName: supportedIndustry(params.industryCode)?.displayName ?? params.industryCode,
    },
    servedIndustries,
    baseQuarter: summary.baseQuarter,
    baseQuarterLabel: quarterLabel(summary.baseQuarter),
    release: {
      releaseKey: release.releaseKey,
      modelVersion: release.modelVersion,
      marketReleaseKey: release.marketReleaseKey,
      activatedAt: release.activatedAt?.toISOString() ?? null,
    },
    score: null,
    contributions: [],
    distribution: null,
    financeDefault: null,
    model: null,
    limitations: SCORE_LIMITATIONS,
  };
  const servedNames = servedIndustries.map((item) => item.displayName);
  if (!served || !industrySummary || !industryModel) {
    return {
      kind: 'OK',
      payload: {
        ...base,
        status: 'UNSUPPORTED_INDUSTRY',
        message: scoreStatusMessage('UNSUPPORTED_INDUSTRY', null, servedNames),
        storeCount: null,
      },
    };
  }

  const modelInfo: MarketScoreResponse['model'] = {
    version: model.version,
    trainPeriod: basisPeriodLabel(industryModel.trainQuarters[0], industryModel.trainQuarters.at(-1)!),
    testPeriod: basisPeriodLabel(industryModel.testQuarters[0], industryModel.testQuarters.at(-1)!),
    trainSize: industryModel.trainSize,
    testSize: industryModel.testSize,
    testAuc: industryModel.testAuc,
    intercept: industryModel.intercept,
    coefficients: industryModel.features.map((feature) => ({
      key: feature.key,
      label: feature.label,
      definition: feature.definition,
      beta: feature.beta,
      standardError: feature.standardError,
      pValue: feature.pValue,
    })),
    gradeBoundaries: model.gradeBoundaries,
  };
  const distribution = { bins: industrySummary.bins, total: industrySummary.scoredCount };

  const row = await prisma.marketScore.findUnique({
    where: {
      releaseId_industryCode_areaType_areaCode: {
        releaseId: release.id,
        industryCode: params.industryCode,
        areaType: area.areaType,
        areaCode: area.areaCode,
      },
    },
  });
  if (!row || row.status !== 'SCORED') {
    const status: MarketScoreStatus = row?.status === 'INSUFFICIENT_STORES' ? 'INSUFFICIENT_STORES' : 'NO_DATA';
    return {
      kind: 'OK',
      payload: {
        ...base,
        status,
        message: scoreStatusMessage(status, row?.storeCount ?? null, servedNames),
        storeCount: row?.storeCount ?? null,
        distribution,
        model: modelInfo,
      },
    };
  }

  const detail = row.detailJson as unknown as ScoreDetail;
  return {
    kind: 'OK',
    payload: {
      ...base,
      status: 'OK',
      message: null,
      storeCount: row.storeCount,
      score: {
        value: row.score!,
        grade: row.grade as Grade,
        rank: row.rank!,
        total: industrySummary.scoredCount,
        topPercent: topPercent(row.rank!, industrySummary.scoredCount),
      },
      contributions: topContributions(detail, industrySummary.featureAverages),
      distribution,
      financeDefault:
        row.monthlyRevenueDefault === null
          ? null
          : {
              monthlyRevenue: row.monthlyRevenueDefault.toFixed(0),
              provisional: true,
              basis: `${base.area.displayName} ${base.industry.displayName} 점포당 평균 기준`,
              salesSum: detail.monthlyRevenueBasis.salesSum,
              storeCountSum: detail.monthlyRevenueBasis.storeCountSum,
              quarters: detail.monthlyRevenueBasis.quarters,
              unusual: revenueOutlier(row.monthlyRevenueDefault.toFixed(0), industrySummary.monthlyRevenueWarningRange),
              warningRange: industrySummary.monthlyRevenueWarningRange,
            },
      model: modelInfo,
    },
  };
}
