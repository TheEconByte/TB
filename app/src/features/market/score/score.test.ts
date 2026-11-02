import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shiftQuarter } from '../quarter.ts';
import { DEFAULT_GRADE_BOUNDARIES, type FeatureKey } from './config.ts';
import {
  buildFeatureRow,
  futureClosureRate,
  labelsByMedian,
  type AreaSeries,
  type QuarterObservation,
} from './dataset.ts';
import { areaUnderCurve, fitLogistic, kolmogorovSmirnov, sigmoid } from './logistic.ts';
import { gradeForScore, marketScoreModelSchema, scoreFeatures, type IndustryModel } from './model.ts';
import {
  buildQuarterSamples,
  evaluateModel,
  isMonotonic,
  labelledBaseQuarters,
  splitByTime,
  type TrainingSample,
} from './train.ts';

const ALL_FEATURES: FeatureKey[] = ['salesGrowth', 'salesPerStore', 'storeCount'];
const boundaries = [...DEFAULT_GRADE_BOUNDARIES];

function series(entries: Record<string, Partial<QuarterObservation> | null>): AreaSeries {
  const byQuarter = new Map<string, QuarterObservation>();
  for (const [quarter, value] of Object.entries(entries)) {
    if (value === null) continue;
    byQuarter.set(quarter, {
      salesAmount: '1000',
      storeCount: 10,
      closedStoreCount: 1,
      openedStoreCount: 1,
      franchiseStoreCount: 2,
      ...value,
    });
  }
  return { areaType: 'A', areaCode: '3110001', industryCode: 'CS100001', byQuarter };
}

describe('shiftQuarter', () => {
  it('연도 경계를 넘어 분기를 옮긴다', () => {
    expect(shiftQuarter('20211', -4)).toBe('20201');
    expect(shiftQuarter('20211', -1)).toBe('20204');
    expect(shiftQuarter('20244', 1)).toBe('20251');
    expect(shiftQuarter('20232', 0)).toBe('20232');
  });
});

describe('변수 계산', () => {
  // t=2024Q3. t−3~t는 2023Q4~2024Q3이고 전년 같은 분기는 2023Q3이다.
  const base = {
    '20232': { salesAmount: '9999' },
    '20234': { salesAmount: '1000', storeCount: 8 },
    '20241': { salesAmount: '1200', storeCount: 10 },
    '20242': { salesAmount: '1400', storeCount: 12 },
    '20243': { salesAmount: '1600', storeCount: 10 },
  };
  const withPrior = { ...base, '20233': { salesAmount: '800' } };

  it('매출 증감률·점포당 매출·점포 수를 정의대로 계산한다', () => {
    const row = buildFeatureRow(series(withPrior), '20243', ALL_FEATURES);
    expect(row.status).toBe('OK');
    if (row.status !== 'OK') return;
    // 전년 같은 분기(2023Q3)와 비교하고, 바로 앞 분기(2023Q2)는 쓰지 않는다.
    expect(row.features.salesGrowth).toBeCloseTo(Math.log(1600 / 800), 10);
    // 매출 합 5200, 평균 점포 수 (8 + 10 + 12 + 10) / 4 = 10
    expect(row.features.salesPerStore).toBeCloseTo(Math.log(5200 / 10), 10);
    expect(row.features.storeCount).toBeCloseTo(Math.log(10), 10);
  });

  it('창 안의 매출 0은 실제 0으로 합산한다', () => {
    const row = buildFeatureRow(series({ ...withPrior, '20241': { salesAmount: '0' } }), '20243', ALL_FEATURES);
    expect(row.status === 'OK' && row.features.salesPerStore).toBeCloseTo(Math.log(4000 / 10), 10);
  });

  it('예외 사유를 구분한다', () => {
    expect(buildFeatureRow(series({ ...withPrior, '20243': null }), '20243', ALL_FEATURES)).toMatchObject({
      status: 'EXCLUDED',
      reason: 'NO_DATA',
    });
    expect(buildFeatureRow(series({ ...withPrior, '20243': { storeCount: 4 } }), '20243', ALL_FEATURES)).toMatchObject({
      reason: 'FEW_STORES',
      storeCount: 4,
    });
    expect(
      buildFeatureRow(series({ ...withPrior, '20243': { salesAmount: '0' } }), '20243', ALL_FEATURES),
    ).toMatchObject({ reason: 'NO_SALES' });
    expect(
      buildFeatureRow(series({ ...withPrior, '20243': { salesAmount: null } }), '20243', ALL_FEATURES),
    ).toMatchObject({ reason: 'NO_SALES' });
    expect(buildFeatureRow(series(base), '20243', ALL_FEATURES)).toMatchObject({ reason: 'NO_PRIOR_SALES' });
    expect(buildFeatureRow(series({ ...withPrior, '20241': null }), '20243', ALL_FEATURES)).toMatchObject({
      reason: 'INCOMPLETE_WINDOW',
    });
  });

  it('최소 점포 수는 설정값으로 바꿀 수 있다', () => {
    const data = series({ ...base, '20233': { salesAmount: '800' }, '20243': { storeCount: 4 } });
    expect(buildFeatureRow(data, '20243', ALL_FEATURES, 3).status).toBe('OK');
  });

  it('직전 1년 폐업률 = t−3~t 폐업 수 합 ÷ t−4 점포 수', () => {
    const data = series({
      '20233': { salesAmount: '800', storeCount: 20 },
      '20234': { salesAmount: '1000', storeCount: 8, closedStoreCount: 2 },
      '20241': { salesAmount: '1200', storeCount: 10, closedStoreCount: 0 },
      '20242': { salesAmount: '1400', storeCount: 12, closedStoreCount: 3 },
      '20243': { salesAmount: '1600', storeCount: 10, closedStoreCount: 1 },
    });
    const row = buildFeatureRow(data, '20243', ['pastClosureRate']);
    expect(row.status === 'OK' && row.features.pastClosureRate).toBeCloseTo(6 / 20, 12);
  });

  it('직전 1년 폐업률을 계산할 수 없으면 0으로 바꾸지 않고 FEATURE_UNAVAILABLE로 뺀다', () => {
    const missingClosure = series({
      ...withPrior,
      '20242': { salesAmount: '1400', storeCount: 12, closedStoreCount: null },
    });
    expect(buildFeatureRow(missingClosure, '20243', ['pastClosureRate'])).toMatchObject({
      reason: 'FEATURE_UNAVAILABLE',
    });
    // 1차 변수만 요청하면 같은 행도 점수를 낸다.
    expect(buildFeatureRow(missingClosure, '20243', ALL_FEATURES).status).toBe('OK');
    const zeroPriorStores = series({ ...withPrior, '20233': { salesAmount: '800', storeCount: 0 } });
    expect(buildFeatureRow(zeroPriorStores, '20243', ['pastClosureRate'])).toMatchObject({
      reason: 'FEATURE_UNAVAILABLE',
    });
  });
});

describe('라벨 계산', () => {
  it('t+1~t+4 폐업 수 합을 t 점포 수로 나눈다', () => {
    const data = series({
      '20241': { storeCount: 20 },
      '20242': { closedStoreCount: 1 },
      '20243': { closedStoreCount: 2 },
      '20244': { closedStoreCount: 0 },
      '20251': { closedStoreCount: 3 },
      '20252': { closedStoreCount: 100 },
    });
    expect(futureClosureRate(data, '20241')).toBeCloseTo(6 / 20, 12);
  });

  it('미래 분기 하나라도 없으면 0이 아니라 null이다', () => {
    const data = series({ '20241': {}, '20242': {}, '20243': {}, '20244': { closedStoreCount: null }, '20251': {} });
    expect(futureClosureRate(data, '20241')).toBeNull();
    expect(futureClosureRate(series({ '20241': {}, '20242': {}, '20243': {}, '20244': {} }), '20241')).toBeNull();
  });

  it('중앙값보다 큰 상권만 1이다', () => {
    expect(labelsByMedian([0.1, 0.4, 0.2, 0.3])).toEqual({ median: 0.25, labels: [0, 1, 0, 1] });
    expect(labelsByMedian([0.1, 0.2, 0.3]).labels).toEqual([0, 0, 1]);
  });
});

describe('시간 기준 분할', () => {
  it('2021Q1~2026Q2에서 기준분기 14개 중 마지막 4개를 테스트로 쓴다', () => {
    const quarters = labelledBaseQuarters('20211', '20262');
    expect(quarters[0]).toBe('20221');
    expect(quarters.at(-1)).toBe('20252');
    expect(quarters).toHaveLength(14);
    const { train, test } = splitByTime(quarters);
    expect(train).toHaveLength(10);
    expect(test).toEqual(['20243', '20244', '20251', '20252']);
  });

  it('기준분기가 4개 이하면 학습하지 않는다', () => {
    expect(() => splitByTime(labelledBaseQuarters('20241', '20262'))).toThrow('학습할 분기가 없습니다');
  });
});

describe('로지스틱 회귀', () => {
  it('합성 자료에서 계수를 복원한다', () => {
    let seed = 42;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    const features: number[][] = [];
    const labels: number[] = [];
    for (let i = 0; i < 20000; i++) {
      const x1 = random() * 4 - 2;
      const x2 = random() * 4 - 2;
      features.push([x1, x2]);
      labels.push(random() < sigmoid(0.5 + 1.2 * x1 - 0.8 * x2) ? 1 : 0);
    }
    const fit = fitLogistic(features, labels);
    expect(fit.converged).toBe(true);
    expect(fit.coefficients[0]).toBeCloseTo(0.5, 1);
    expect(fit.coefficients[1]).toBeCloseTo(1.2, 1);
    expect(fit.coefficients[2]).toBeCloseTo(-0.8, 1);
    expect(fit.standardErrors.every((value) => value > 0 && value < 0.1)).toBe(true);
  });

  it('AUC는 순위로 계산하고 동점은 절반으로 센다', () => {
    expect(areaUnderCurve([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(areaUnderCurve([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(areaUnderCurve([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
  });

  it('KS는 두 집단 점수 누적분포 차이의 최댓값이고 같은 점수는 한 번에 넘긴다', () => {
    expect(kolmogorovSmirnov([10, 20, 80, 90], [1, 1, 0, 0])).toBe(1);
    expect(kolmogorovSmirnov([50, 50, 50, 50], [1, 0, 1, 0])).toBe(0);
    // 양성 30·60, 음성 40·70 → 30점에서 0.5, 40점에서 0, 60점에서 0.5
    expect(kolmogorovSmirnov([30, 60, 40, 70], [1, 1, 0, 0])).toBe(0.5);
  });
});

describe('점수·등급 변환', () => {
  it('등급 경계는 하한을 포함한다', () => {
    expect(gradeForScore(100, boundaries)).toBe('AAA');
    expect(gradeForScore(90, boundaries)).toBe('AAA');
    expect(gradeForScore(89, boundaries)).toBe('AA');
    expect(gradeForScore(60, boundaries)).toBe('BBB');
    expect(gradeForScore(30, boundaries)).toBe('C');
    expect(gradeForScore(29, boundaries)).toBe('D');
    expect(gradeForScore(0, boundaries)).toBe('D');
  });

  const model: IndustryModel = {
    industryCode: 'CS100001',
    industryName: '한식',
    intercept: 0,
    features: [
      {
        key: 'salesGrowth',
        label: '매출 증감률',
        definition: '',
        expectedScoreDirection: 1,
        beta: -0.5,
        standardError: 0.1,
        pValue: 0,
        mean: 0,
        std: 1,
      },
      {
        key: 'salesPerStore',
        label: '점포당 매출',
        definition: '',
        expectedScoreDirection: 1,
        beta: -1,
        standardError: 0.1,
        pValue: 0,
        mean: 10,
        std: 2,
      },
      {
        key: 'storeCount',
        label: '동일 업종 점포 수',
        definition: '',
        expectedScoreDirection: 0,
        beta: 0.2,
        standardError: 0.1,
        pValue: 0,
        mean: 2,
        std: 1,
      },
    ],
    trainQuarters: ['20221'],
    testQuarters: ['20243'],
    trainSize: 1,
    testSize: 1,
    trainPositiveRate: 0.5,
    testPositiveRate: 0.5,
    trainAuc: 0.6,
    testAuc: 0.6,
    zClip: 3,
  };

  it('평균 상권은 50점이다', () => {
    const scored = scoreFeatures(model, { salesGrowth: 0, salesPerStore: 10, storeCount: 2 }, boundaries);
    expect(scored.probability).toBeCloseTo(0.5, 12);
    expect(scored.score).toBe(50);
    expect(scored.grade).toBe('BB');
  });

  it('점수 = round((1 − p) × 100), 기여도 = −β × z이고 절댓값 순으로 정렬한다', () => {
    const scored = scoreFeatures(model, { salesGrowth: 1, salesPerStore: 6, storeCount: 3 }, boundaries);
    // z: 1, −2, 1 → logit = −0.5 + 2 + 0.2 = 1.7
    expect(scored.probability).toBeCloseTo(sigmoid(1.7), 12);
    expect(scored.score).toBe(Math.round((1 - sigmoid(1.7)) * 100));
    expect(scored.contributions.map((item) => item.key)).toEqual(['salesPerStore', 'salesGrowth', 'storeCount']);
    expect(scored.contributions.map((item) => item.contribution)).toEqual([-2, 0.5, -0.2]);
    expect(scored.contributions[0]).toMatchObject({ value: 6, z: -2 });
  });

  it('표준화 값은 ±zClip에서 잘라 극단값 하나가 점수를 좌우하지 않게 한다', () => {
    const extreme = scoreFeatures(model, { salesGrowth: 0, salesPerStore: 40, storeCount: 2 }, boundaries);
    const capped = scoreFeatures(model, { salesGrowth: 0, salesPerStore: 16, storeCount: 2 }, boundaries);
    // (40 − 10) / 2 = 15 → 3으로 자른다. 원값은 그대로 남긴다.
    expect(extreme.contributions[0]).toMatchObject({ key: 'salesPerStore', value: 40, z: 3, contribution: 3 });
    expect(extreme.score).toBe(capped.score);
  });

  it('모델이 쓰는 변수 값이 없으면 점수를 내지 않는다', () => {
    expect(() => scoreFeatures(model, { salesGrowth: 0, storeCount: 2 }, boundaries)).toThrow('점포당 매출');
  });

  it('등급 단조성은 표본 없는 등급을 건너뛴다', () => {
    expect(
      isMonotonic([
        { grade: 'AAA', count: 0, highClosureRate: null, meanClosureRate: null },
        { grade: 'AA', count: 5, highClosureRate: 0.2, meanClosureRate: 0.1 },
        { grade: 'A', count: 5, highClosureRate: 0.2, meanClosureRate: 0.1 },
        { grade: 'D', count: 5, highClosureRate: 0.6, meanClosureRate: 0.3 },
      ]),
    ).toBe(true);
    expect(
      isMonotonic([
        { grade: 'AA', count: 5, highClosureRate: 0.4, meanClosureRate: 0.2 },
        { grade: 'A', count: 5, highClosureRate: 0.3, meanClosureRate: 0.2 },
      ]),
    ).toBe(false);
  });

  it('기준선 비교 평가는 같은 점수 변환·등급 구간으로 등급별 결과를 낸다', () => {
    const samples: TrainingSample[] = [
      {
        areaCode: 'a',
        quarter: '20243',
        features: { salesGrowth: 0, salesPerStore: 10, storeCount: 2 } as Record<FeatureKey, number>,
        closureRate: 0.1,
        label: 0,
      },
      {
        areaCode: 'b',
        quarter: '20243',
        features: { salesGrowth: 0, salesPerStore: 10, storeCount: 2 } as Record<FeatureKey, number>,
        closureRate: 0.3,
        label: 1,
      },
      // z = 3, 3, 0 → logit = −4.5 → 99점
      {
        areaCode: 'c',
        quarter: '20243',
        features: { salesGrowth: 3, salesPerStore: 16, storeCount: 2 } as Record<FeatureKey, number>,
        closureRate: 0.05,
        label: 0,
      },
    ];
    const evaluation = evaluateModel({ ...model, testAuc: 0.7 }, samples, boundaries);
    expect(evaluation.testAuc).toBe(0.7);
    expect(evaluation.testScores).toEqual([50, 50, 99]);
    expect(evaluation.gradeOutcomes.find((o) => o.grade === 'BB')).toEqual({
      grade: 'BB',
      count: 2,
      highClosureRate: 0.5,
      meanClosureRate: 0.2,
    });
    expect(evaluation.gradeOutcomes.find((o) => o.grade === 'AAA')).toMatchObject({ count: 1, highClosureRate: 0 });
    expect(evaluation.gradeOutcomes.find((o) => o.grade === 'D')).toEqual({
      grade: 'D',
      count: 0,
      highClosureRate: null,
      meanClosureRate: null,
    });
    // 양성 50점, 음성 50·99점 → 50점에서 |1 − 0.5|
    expect(evaluation.ks).toBe(0.5);
  });
});

describe('기준선 비교 표본', () => {
  const full = (overrides: Record<string, Partial<QuarterObservation>> = {}) =>
    series({
      '20233': {},
      '20234': {},
      '20241': {},
      '20242': {},
      '20243': {},
      '20244': {},
      '20251': {},
      '20252': {},
      '20253': {},
      ...overrides,
    });

  it('모든 비교 모델의 변수를 계산할 수 있는 행만 같은 표본으로 쓴다', () => {
    const complete = full();
    const missingClosure = { ...full({ '20242': { closedStoreCount: null } }), areaCode: '3110002' };
    expect(buildQuarterSamples([complete, missingClosure], '20243', ALL_FEATURES, 5).samples).toHaveLength(2);
    const shared = buildQuarterSamples([complete, missingClosure], '20243', [...ALL_FEATURES, 'pastClosureRate'], 5);
    expect(shared.samples.map((sample) => sample.areaCode)).toEqual(['3110001']);
    expect(shared.exclusions.FEATURE_UNAVAILABLE).toBe(1);
  });
});

describe('계수 파일', () => {
  const dir = resolve(import.meta.dirname, '../../../../models/market-score');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

  it.each(files)('%s는 계수 파일 스키마를 따른다', (name) => {
    const model = marketScoreModelSchema.parse(JSON.parse(readFileSync(resolve(dir, name), 'utf8')));
    expect(`${model.version}.json`).toBe(name);
  });
});
