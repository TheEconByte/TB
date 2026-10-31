import Decimal from 'decimal.js';
import { shiftQuarter } from '../quarter.ts';
import { GRADES, MIN_TEST_AUC, MONTHLY_REVENUE_WARNING_QUANTILES, type FeatureKey, type Grade } from './config.ts';
import {
  FEATURE_DEFINITIONS,
  buildFeatureRow,
  type AreaSeries,
  type DisplayUnit,
  type ExclusionReason,
} from './dataset.ts';
import { scoreFeatures, type MarketScoreModel } from './model.ts';
import { scoreBins } from './train.ts';

// score:build가 최신 기준분기의 상권별 점수를 만든다(ADR 0008). DB와 React에 의존하지 않는다.

export type ScoreStatus = 'SCORED' | 'INSUFFICIENT_STORES' | 'NO_DATA';

// 화면 표시값은 단위와 상관없이 문자열이다. 금액은 원 단위 정수, 비율은 소수(0.1234), 개수는 정수다.
export type FeatureDetail = {
  key: FeatureKey;
  label: string;
  displayLabel: string;
  unit: DisplayUnit;
  displayValue: string;
  value: number;
  z: number;
  contribution: number;
};

export type ScoreDetail = {
  // 기여도 절댓값이 큰 순서
  features: FeatureDetail[];
  // 월매출 기본값의 근거: t−3~t 매출 원값 합과 점포 수 합
  monthlyRevenueBasis: { quarters: string[]; salesSum: string; storeCountSum: number };
};

export type BuiltScoreRow = {
  industryCode: string;
  areaType: string;
  areaCode: string;
  status: ScoreStatus;
  storeCount: number | null;
  score: number | null;
  grade: Grade | null;
  probability: number | null;
  rank: number | null;
  monthlyRevenueDefault: string | null;
  detail: ScoreDetail | null;
};

export type IndustryScoreSummary = {
  industryCode: string;
  industryName: string;
  // 테스트 AUC가 기준 이상이라 점수를 내는 업종인지
  served: boolean;
  testAuc: number;
  scoredCount: number;
  bins: { from: number; to: number; count: number }[];
  gradeCounts: Record<Grade, number>;
  // 점수 낸 상권의 화면 표시값 평균
  featureAverages: Partial<Record<FeatureKey, string>>;
  // 월매출 기본값의 하위·상위 경계(MONTHLY_REVENUE_WARNING_QUANTILES 분위수, 원). 밖이면 화면에 경고를 붙인다.
  monthlyRevenueWarningRange: { low: string; high: string } | null;
  exclusions: Record<ExclusionReason, number>;
};

export type ScoreSummary = {
  baseQuarter: string;
  minTestAuc: number;
  servedIndustryCodes: string[];
  industries: IndustryScoreSummary[];
};

const PERCENT_DIGITS = 6;

function formatDisplay(unit: DisplayUnit, value: Decimal): string {
  if (unit === 'WON') return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
  if (unit === 'PERCENT') return value.toDecimalPlaces(PERCENT_DIGITS, Decimal.ROUND_HALF_UP).toFixed(PERCENT_DIGITS);
  return value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(value.isInteger() ? 0 : 1);
}

// t−(count−1) ~ t, 오래된 순
function windowQuarters(quarter: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftQuarter(quarter, i - (count - 1)));
}

export function rankScores(scores: readonly number[]): number[] {
  // 점수가 같으면 같은 순위. 순위 = 1 + 더 높은 점수의 수.
  const sorted = [...scores].sort((a, b) => b - a);
  return scores.map((score) => 1 + sorted.findIndex((value) => value === score));
}

// 월매출 기본값이 같은 업종 경고 범위 밖인지. 범위가 없으면 판정하지 않는다.
export function revenueOutlier(
  value: string,
  range: IndustryScoreSummary['monthlyRevenueWarningRange'],
): 'HIGH' | 'LOW' | null {
  if (!range) return null;
  const amount = new Decimal(value);
  if (amount.greaterThan(range.high)) return 'HIGH';
  if (amount.lessThan(range.low)) return 'LOW';
  return null;
}

// 최근접 순위 분위수(nearest-rank). 값이 없으면 null.
export function quantile(values: readonly Decimal[], q: number): string | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)].toFixed(0);
}

export function topPercent(rank: number, total: number): number {
  return Math.max(1, Math.ceil((rank / total) * 100));
}

export function buildScores(input: {
  model: MarketScoreModel;
  seriesByIndustry: ReadonlyMap<string, readonly AreaSeries[]>;
  areas: readonly { areaType: string; areaCode: string }[];
  quarter: string;
}): { rows: BuiltScoreRow[]; summary: ScoreSummary } {
  const rows: BuiltScoreRow[] = [];
  const industries: IndustryScoreSummary[] = [];

  for (const industryModel of input.model.industries) {
    const served = industryModel.testAuc >= MIN_TEST_AUC;
    const exclusions: Record<ExclusionReason, number> = {
      NO_DATA: 0,
      FEW_STORES: 0,
      NO_SALES: 0,
      NO_PRIOR_SALES: 0,
      INCOMPLETE_WINDOW: 0,
      FEATURE_UNAVAILABLE: 0,
    };
    const summary: IndustryScoreSummary = {
      industryCode: industryModel.industryCode,
      industryName: industryModel.industryName,
      served,
      testAuc: industryModel.testAuc,
      scoredCount: 0,
      bins: scoreBins([]),
      gradeCounts: Object.fromEntries(GRADES.map((grade) => [grade, 0])) as Record<Grade, number>,
      featureAverages: {},
      monthlyRevenueWarningRange: null,
      exclusions,
    };
    industries.push(summary);
    if (!served) continue;

    const seriesByArea = new Map(
      (input.seriesByIndustry.get(industryModel.industryCode) ?? []).map((series) => [
        `${series.areaType}|${series.areaCode}`,
        series,
      ]),
    );
    const featureKeys = industryModel.features.map((feature) => feature.key);
    const industryRows: BuiltScoreRow[] = [];
    for (const area of input.areas) {
      const base = {
        industryCode: industryModel.industryCode,
        areaType: area.areaType,
        areaCode: area.areaCode,
      };
      const series = seriesByArea.get(`${area.areaType}|${area.areaCode}`);
      const row = series
        ? buildFeatureRow(series, input.quarter, featureKeys, input.model.minStoreCount)
        : ({ status: 'EXCLUDED', reason: 'NO_DATA', storeCount: null } as const);
      if (row.status === 'EXCLUDED') {
        exclusions[row.reason]++;
        industryRows.push({
          ...base,
          status: row.reason === 'FEW_STORES' ? 'INSUFFICIENT_STORES' : 'NO_DATA',
          storeCount: row.storeCount,
          score: null,
          grade: null,
          probability: null,
          rank: null,
          monthlyRevenueDefault: null,
          detail: null,
        });
        continue;
      }
      const scored = scoreFeatures(industryModel, row.features, input.model.gradeBoundaries);
      const salesSum = new Decimal(row.window.window.reduce((sum, item) => sum + item.salesAmount, 0));
      const storeCountSum = row.window.window.reduce((sum, item) => sum + item.storeCount, 0);
      industryRows.push({
        ...base,
        status: 'SCORED',
        storeCount: row.storeCount,
        score: scored.score,
        grade: scored.grade,
        probability: scored.probability,
        rank: null,
        // ADR 0002: 원값은 분기 월평균이다. 4분기 평균 ÷ 평균 점포 수 = 매출 합 ÷ 점포 수 합.
        monthlyRevenueDefault: salesSum.div(storeCountSum).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
        detail: {
          features: scored.contributions.map((item) => {
            const definition = FEATURE_DEFINITIONS[item.key];
            return {
              key: item.key,
              label: item.label,
              displayLabel: definition.display.label,
              unit: definition.display.unit,
              displayValue: formatDisplay(
                definition.display.unit,
                item.key === 'salesPerStore'
                  ? salesSum.div(storeCountSum)
                  : new Decimal(definition.display.value(row.window)),
              ),
              value: item.value,
              z: item.z,
              contribution: item.contribution,
            };
          }),
          monthlyRevenueBasis: {
            quarters: windowQuarters(input.quarter, row.window.window.length),
            salesSum: salesSum.toFixed(0),
            storeCountSum,
          },
        },
      });
    }

    const scoredRows = industryRows.filter((row) => row.status === 'SCORED');
    const ranks = rankScores(scoredRows.map((row) => row.score!));
    scoredRows.forEach((row, i) => {
      row.rank = ranks[i];
      summary.gradeCounts[row.grade!]++;
    });
    summary.scoredCount = scoredRows.length;
    summary.bins = scoreBins(scoredRows.map((row) => row.score!));
    const revenues = scoredRows.map((row) => new Decimal(row.monthlyRevenueDefault!));
    const low = quantile(revenues, MONTHLY_REVENUE_WARNING_QUANTILES.low);
    const high = quantile(revenues, MONTHLY_REVENUE_WARNING_QUANTILES.high);
    summary.monthlyRevenueWarningRange = low !== null && high !== null ? { low, high } : null;
    for (const key of featureKeys) {
      const unit = FEATURE_DEFINITIONS[key].display.unit;
      const values = scoredRows.map(
        (row) => new Decimal(row.detail!.features.find((feature) => feature.key === key)!.displayValue),
      );
      if (values.length === 0) continue;
      summary.featureAverages[key] = formatDisplay(
        unit,
        values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length),
      );
    }
    rows.push(...industryRows);
  }

  return {
    rows,
    summary: {
      baseQuarter: input.quarter,
      minTestAuc: MIN_TEST_AUC,
      servedIndustryCodes: industries.filter((item) => item.served).map((item) => item.industryCode),
      industries,
    },
  };
}
