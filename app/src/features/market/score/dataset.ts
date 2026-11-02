import { shiftQuarter } from '../quarter.ts';
import {
  GROWTH_LAG_QUARTERS,
  LABEL_HORIZON_QUARTERS,
  MIN_STORE_COUNT,
  PER_STORE_WINDOW_QUARTERS,
  type FeatureKey,
} from './config.ts';

// 한 상권·업종의 분기 관측값. 점포 수는 유사_업종_점포_수(ADR 0002의 분모)다.
// 행이 없거나 값이 없으면 null이며 0으로 바꾸지 않는다.
export type QuarterObservation = {
  salesAmount: string | null;
  storeCount: number | null;
  closedStoreCount: number | null;
  openedStoreCount: number | null;
  franchiseStoreCount: number | null;
};

export type AreaSeries = {
  areaType: string;
  areaCode: string;
  industryCode: string;
  byQuarter: ReadonlyMap<string, QuarterObservation>;
};

export type ExclusionReason =
  | 'NO_DATA' // t 분기 행이나 점포 수가 없음
  | 'FEW_STORES' // t 분기 점포 수가 최소 점포 수 미만
  | 'NO_SALES' // t 분기 매출이 0이거나 없음
  | 'NO_PRIOR_SALES' // t−4 분기 매출이 0이거나 없음
  | 'INCOMPLETE_WINDOW' // t−3 ~ t−1 분기 매출이나 점포 수가 없음
  | 'FEATURE_UNAVAILABLE'; // 요청한 변수를 계산할 값이 없음(예: 직전 1년 폐업률의 폐업 수·t−4 점포 수)

export type FeatureWindow = {
  current: { salesAmount: number; storeCount: number; franchiseStoreCount: number | null };
  // t−4 점포 수가 없거나 0이면 null
  prior: { salesAmount: number; storeCount: number | null };
  // t−3 ~ t, 오래된 순
  window: {
    salesAmount: number;
    storeCount: number;
    closedStoreCount: number | null;
    openedStoreCount: number | null;
  }[];
};

// 화면에 보여 줄 값의 단위. 금액은 원 단위 정수로 반올림해 문자열로 낸다.
export type DisplayUnit = 'PERCENT' | 'WON' | 'COUNT';

export type FeatureRow =
  | { status: 'OK'; storeCount: number; window: FeatureWindow; features: Record<FeatureKey, number> }
  | { status: 'EXCLUDED'; reason: ExclusionReason; storeCount: number | null };

type FeatureDefinition = {
  label: string;
  // 점수 기준 예상 방향: 1이면 값이 클수록 점수를 올릴 것으로 예상, 0이면 예상 방향 없음.
  expectedScoreDirection: 1 | 0 | -1;
  definition: string;
  // 계산할 값이 없으면 null이다.
  compute: (window: FeatureWindow) => number | null;
  // 화면 표시값(로그를 풀거나 비율 그대로). compute가 값을 낸 행에서만 부른다.
  display: { label: string; unit: DisplayUnit; value: (window: FeatureWindow) => number };
};

function sumWindow(window: FeatureWindow['window'], key: 'closedStoreCount' | 'openedStoreCount'): number | null {
  let total = 0;
  for (const item of window) {
    const value = item[key];
    if (value === null) return null;
    total += value;
  }
  return total;
}

const windowSales = (w: FeatureWindow) => w.window.reduce((sum, item) => sum + item.salesAmount, 0);
const windowStores = (w: FeatureWindow) => w.window.reduce((sum, item) => sum + item.storeCount, 0);

export const FEATURE_DEFINITIONS: Record<FeatureKey, FeatureDefinition> = {
  salesGrowth: {
    label: '매출 증감률',
    expectedScoreDirection: 1,
    definition: 'log(t 매출) − log(t−4 매출)',
    compute: (w) => Math.log(w.current.salesAmount) - Math.log(w.prior.salesAmount),
    display: {
      label: '전년 같은 분기 대비 매출',
      unit: 'PERCENT',
      value: (w) => w.current.salesAmount / w.prior.salesAmount - 1,
    },
  },
  salesPerStore: {
    label: '점포당 매출',
    expectedScoreDirection: 1,
    definition: 'log(t−3~t 매출 합 ÷ t−3~t 평균 점포 수)',
    compute: (w) => Math.log(windowSales(w) / (windowStores(w) / w.window.length)),
    // ADR 0002: 원값은 분기 월평균이므로 4분기 평균 ÷ 평균 점포 수 = 매출 합 ÷ 점포 수 합이다.
    display: { label: '점포당 월매출(잠정)', unit: 'WON', value: (w) => windowSales(w) / windowStores(w) },
  },
  storeCount: {
    label: '동일 업종 점포 수',
    expectedScoreDirection: 0,
    definition: 'log(t 점포 수)',
    compute: (w) => Math.log(w.current.storeCount),
    display: { label: '점포 수', unit: 'COUNT', value: (w) => w.current.storeCount },
  },
  // 기준선. 서울시 상권분석서비스가 공개하는 분기 폐업률을 1년 단위로 합친 값이다.
  pastClosureRate: {
    label: '직전 1년 폐업률',
    expectedScoreDirection: -1,
    definition: 't−3~t 폐업 수 합 ÷ t−4 점포 수',
    compute: (w) => {
      const closed = sumWindow(w.window, 'closedStoreCount');
      return closed === null || w.prior.storeCount === null ? null : closed / w.prior.storeCount;
    },
    display: {
      label: '직전 1년 폐업률',
      unit: 'PERCENT',
      value: (w) => sumWindow(w.window, 'closedStoreCount')! / w.prior.storeCount!,
    },
  },
  pastOpenRate: {
    label: '직전 1년 개업률',
    expectedScoreDirection: 0,
    definition: 't−3~t 개업 수 합 ÷ t−4 점포 수',
    compute: (w) => {
      const opened = sumWindow(w.window, 'openedStoreCount');
      return opened === null || w.prior.storeCount === null ? null : opened / w.prior.storeCount;
    },
    display: {
      label: '직전 1년 개업률',
      unit: 'PERCENT',
      value: (w) => sumWindow(w.window, 'openedStoreCount')! / w.prior.storeCount!,
    },
  },
  franchiseShare: {
    label: '프랜차이즈 비중',
    expectedScoreDirection: 0,
    definition: 't 프랜차이즈 점포 수 ÷ t 점포 수',
    compute: (w) =>
      w.current.franchiseStoreCount === null ? null : w.current.franchiseStoreCount / w.current.storeCount,
    display: {
      label: '프랜차이즈 비중',
      unit: 'PERCENT',
      value: (w) => w.current.franchiseStoreCount! / w.current.storeCount,
    },
  },
};

function positiveSales(observation: QuarterObservation | undefined): number | null {
  if (!observation || observation.salesAmount === null) return null;
  const value = Number(observation.salesAmount);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function buildFeatureRow(
  series: AreaSeries,
  quarter: string,
  featureKeys: readonly FeatureKey[],
  minStoreCount = MIN_STORE_COUNT,
): FeatureRow {
  const current = series.byQuarter.get(quarter);
  if (!current || current.storeCount === null) return { status: 'EXCLUDED', reason: 'NO_DATA', storeCount: null };
  const storeCount = current.storeCount;
  if (storeCount < minStoreCount) return { status: 'EXCLUDED', reason: 'FEW_STORES', storeCount };

  const currentSales = positiveSales(current);
  if (currentSales === null) return { status: 'EXCLUDED', reason: 'NO_SALES', storeCount };
  const prior = series.byQuarter.get(shiftQuarter(quarter, -GROWTH_LAG_QUARTERS));
  const priorSales = positiveSales(prior);
  if (priorSales === null) return { status: 'EXCLUDED', reason: 'NO_PRIOR_SALES', storeCount };

  const window: FeatureWindow['window'] = [];
  for (let offset = PER_STORE_WINDOW_QUARTERS - 1; offset >= 0; offset--) {
    const observation = series.byQuarter.get(shiftQuarter(quarter, -offset));
    // 창 안의 매출 0은 실제 0으로 합산한다. 행이나 값이 없으면 계산하지 않는다.
    if (!observation || observation.salesAmount === null || observation.storeCount === null) {
      return { status: 'EXCLUDED', reason: 'INCOMPLETE_WINDOW', storeCount };
    }
    window.push({
      salesAmount: Number(observation.salesAmount),
      storeCount: observation.storeCount,
      closedStoreCount: observation.closedStoreCount,
      openedStoreCount: observation.openedStoreCount,
    });
  }

  const featureWindow: FeatureWindow = {
    current: { salesAmount: currentSales, storeCount, franchiseStoreCount: current.franchiseStoreCount },
    prior: { salesAmount: priorSales, storeCount: prior?.storeCount ? prior.storeCount : null },
    window,
  };
  const features = {} as Record<FeatureKey, number>;
  for (const key of featureKeys) {
    const value = FEATURE_DEFINITIONS[key].compute(featureWindow);
    if (value === null) return { status: 'EXCLUDED', reason: 'FEATURE_UNAVAILABLE', storeCount };
    features[key] = value;
  }
  return { status: 'OK', storeCount, window: featureWindow, features };
}

// 향후 1년 폐업률. 미래 분기 행이나 폐업 수가 하나라도 없으면 null(라벨 미확정)이다.
export function futureClosureRate(
  series: AreaSeries,
  quarter: string,
  horizon = LABEL_HORIZON_QUARTERS,
): number | null {
  const current = series.byQuarter.get(quarter);
  if (!current?.storeCount) return null;
  let closed = 0;
  for (let offset = 1; offset <= horizon; offset++) {
    const observation = series.byQuarter.get(shiftQuarter(quarter, offset));
    if (!observation || observation.closedStoreCount === null) return null;
    closed += observation.closedStoreCount;
  }
  return closed / current.storeCount;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('중앙값을 구할 값이 없습니다.');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// 같은 업종·같은 기준분기의 중앙값보다 높으면 1(고폐업)이다.
export function labelsByMedian(rates: readonly number[]): { median: number; labels: (0 | 1)[] } {
  const cut = median(rates);
  return { median: cut, labels: rates.map((rate) => (rate > cut ? 1 : 0)) };
}
