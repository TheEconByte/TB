import { quartersBetween, shiftQuarter } from '../quarter.ts';
import {
  GROWTH_LAG_QUARTERS,
  LABEL_HORIZON_QUARTERS,
  PER_STORE_WINDOW_QUARTERS,
  TEST_QUARTER_COUNT,
  Z_CLIP,
  type ComparisonModelId,
  type FeatureKey,
  type Grade,
} from './config.ts';
import {
  FEATURE_DEFINITIONS,
  buildFeatureRow,
  futureClosureRate,
  labelsByMedian,
  type AreaSeries,
  type ExclusionReason,
} from './dataset.ts';
import {
  areaUnderCurve,
  fitLogistic,
  kolmogorovSmirnov,
  meanAndStd,
  pearson,
  sigmoid,
  waldPValue,
} from './logistic.ts';
import { clippedZ, scoreFeatures, type IndustryModel, type MarketScoreModel, type ScoredRow } from './model.ts';

export type SampleExclusion = ExclusionReason | 'NO_FUTURE_DATA';

export type TrainingSample = {
  areaCode: string;
  quarter: string;
  features: Record<FeatureKey, number>;
  closureRate: number;
  label: 0 | 1;
};

// 변수(t−4, t−3~t)와 라벨(t+1~t+4)을 모두 계산할 수 있는 기준분기.
export function labelledBaseQuarters(start: string, end: string): string[] {
  const lookback = Math.max(GROWTH_LAG_QUARTERS, PER_STORE_WINDOW_QUARTERS - 1);
  const first = shiftQuarter(start, lookback);
  const last = shiftQuarter(end, -LABEL_HORIZON_QUARTERS);
  return quartersBetween(first, last);
}

export function splitByTime(baseQuarters: readonly string[]): { train: string[]; test: string[] } {
  if (baseQuarters.length <= TEST_QUARTER_COUNT) {
    throw new Error(
      `기준분기가 ${baseQuarters.length}개라 테스트 ${TEST_QUARTER_COUNT}개를 떼면 학습할 분기가 없습니다.`,
    );
  }
  return {
    train: baseQuarters.slice(0, -TEST_QUARTER_COUNT),
    test: baseQuarters.slice(-TEST_QUARTER_COUNT),
  };
}

export type QuarterSamples = {
  quarter: string;
  samples: TrainingSample[];
  median: number | null;
  exclusions: Record<SampleExclusion, number>;
};

function emptyExclusions(): Record<SampleExclusion, number> {
  return {
    NO_DATA: 0,
    FEW_STORES: 0,
    NO_SALES: 0,
    NO_PRIOR_SALES: 0,
    INCOMPLETE_WINDOW: 0,
    FEATURE_UNAVAILABLE: 0,
    NO_FUTURE_DATA: 0,
  };
}

// featureKeys의 변수를 모두 계산할 수 있는 행만 표본이 된다. 비교 모델들이 같은 행을 쓰도록
// 모든 모델의 변수 합집합을 넘긴다. 라벨 중앙값은 이 표본 안에서 구한다.
export function buildQuarterSamples(
  seriesList: readonly AreaSeries[],
  quarter: string,
  featureKeys: readonly FeatureKey[],
  minStoreCount: number,
): QuarterSamples {
  const exclusions = emptyExclusions();
  const pending: Omit<TrainingSample, 'label'>[] = [];
  for (const series of seriesList) {
    const row = buildFeatureRow(series, quarter, featureKeys, minStoreCount);
    if (row.status === 'EXCLUDED') {
      exclusions[row.reason]++;
      continue;
    }
    const closureRate = futureClosureRate(series, quarter);
    if (closureRate === null) {
      exclusions.NO_FUTURE_DATA++;
      continue;
    }
    pending.push({ areaCode: series.areaCode, quarter, features: row.features, closureRate });
  }
  if (pending.length === 0) return { quarter, samples: [], median: null, exclusions };
  const { median, labels } = labelsByMedian(pending.map((item) => item.closureRate));
  return { quarter, samples: pending.map((item, i) => ({ ...item, label: labels[i] })), median, exclusions };
}

export type GradeOutcome = {
  grade: Grade;
  count: number;
  // 고폐업(라벨 1) 비율
  highClosureRate: number | null;
  // 실제 향후 1년 폐업률 평균
  meanClosureRate: number | null;
};

export type ModelEvaluation = {
  testAuc: number;
  ks: number;
  testScores: number[];
  gradeOutcomes: GradeOutcome[];
};

export type ComparisonResult = {
  id: ComparisonModelId;
  label: string;
  model: IndustryModel;
  evaluation: ModelEvaluation;
};

export type IndustryTrainingResult = {
  // 계수 파일에 저장하는 생존점수 모델
  model: IndustryModel;
  evaluation: ModelEvaluation;
  quarterSamples: QuarterSamples[];
  correlations: { left: FeatureKey; right: FeatureKey; r: number }[];
  comparisons: ComparisonResult[];
  converged: boolean;
  iterations: number;
};

export function scoreBins(scores: readonly number[]): { from: number; to: number; count: number }[] {
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9, count: 0 }));
  for (const score of scores) bins[Math.min(9, Math.floor(score / 10))].count++;
  return bins;
}

const positiveRate = (samples: readonly TrainingSample[]) =>
  samples.filter((sample) => sample.label === 1).length / samples.length;

function fitIndustryModel(input: {
  industryCode: string;
  industryName: string;
  featureKeys: readonly FeatureKey[];
  train: string[];
  test: string[];
  trainSamples: readonly TrainingSample[];
  testSamples: readonly TrainingSample[];
}): { model: IndustryModel; converged: boolean; iterations: number } {
  const { featureKeys, trainSamples, testSamples } = input;
  const scaling = featureKeys.map((key) => meanAndStd(trainSamples.map((sample) => sample.features[key])));
  const standardize = (sample: TrainingSample) =>
    featureKeys.map((key, j) => clippedZ(sample.features[key], scaling[j].mean, scaling[j].std, Z_CLIP));
  const fit = fitLogistic(
    trainSamples.map(standardize),
    trainSamples.map((sample) => sample.label),
  );
  const predict = (sample: TrainingSample) =>
    sigmoid(standardize(sample).reduce((sum, value, j) => sum + value * fit.coefficients[j + 1], fit.coefficients[0]));

  const model: IndustryModel = {
    industryCode: input.industryCode,
    industryName: input.industryName,
    intercept: fit.coefficients[0],
    features: featureKeys.map((key, j) => ({
      key,
      label: FEATURE_DEFINITIONS[key].label,
      definition: FEATURE_DEFINITIONS[key].definition,
      expectedScoreDirection: FEATURE_DEFINITIONS[key].expectedScoreDirection,
      beta: fit.coefficients[j + 1],
      standardError: fit.standardErrors[j + 1],
      pValue: waldPValue(fit.coefficients[j + 1], fit.standardErrors[j + 1]),
      mean: scaling[j].mean,
      std: scaling[j].std,
    })),
    trainQuarters: input.train,
    testQuarters: input.test,
    trainSize: trainSamples.length,
    testSize: testSamples.length,
    trainPositiveRate: positiveRate(trainSamples),
    testPositiveRate: positiveRate(testSamples),
    trainAuc: areaUnderCurve(
      trainSamples.map(predict),
      trainSamples.map((sample) => sample.label),
    ),
    testAuc: areaUnderCurve(
      testSamples.map(predict),
      testSamples.map((sample) => sample.label),
    ),
    zClip: Z_CLIP,
  };
  return { model, converged: fit.converged, iterations: fit.iterations };
}

// 점수 변환과 등급 구간을 모델과 상관없이 똑같이 적용해 테스트셋을 평가한다.
export function evaluateModel(
  model: IndustryModel,
  testSamples: readonly TrainingSample[],
  gradeBoundaries: MarketScoreModel['gradeBoundaries'],
): ModelEvaluation {
  const scored = testSamples.map((sample) => ({
    sample,
    scored: scoreFeatures(model, sample.features, gradeBoundaries),
  }));
  const labels = testSamples.map((sample) => sample.label);
  const scores = scored.map((item) => item.scored.score);
  const mean = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    testAuc: model.testAuc,
    // 점수가 높을수록 생존 쪽이므로 KS는 방향과 무관한 절댓값 차이다.
    ks: kolmogorovSmirnov(scores, labels),
    testScores: scores,
    gradeOutcomes: gradeBoundaries.map(({ grade }) => {
      const inGrade = scored.filter((item) => item.scored.grade === grade);
      return {
        grade,
        count: inGrade.length,
        highClosureRate: mean(inGrade.map((item) => item.sample.label)),
        meanClosureRate: mean(inGrade.map((item) => item.sample.closureRate)),
      };
    }),
  };
}

export function trainIndustryModel(input: {
  industryCode: string;
  industryName: string;
  seriesList: readonly AreaSeries[];
  dataStart: string;
  dataEnd: string;
  featureKeys: readonly FeatureKey[];
  comparisonModels: readonly { id: ComparisonModelId; label: string; featureKeys: readonly FeatureKey[] }[];
  minStoreCount: number;
  gradeBoundaries: MarketScoreModel['gradeBoundaries'];
}): IndustryTrainingResult {
  const { train, test } = splitByTime(labelledBaseQuarters(input.dataStart, input.dataEnd));
  const sampleKeys = [
    ...new Set([...input.featureKeys, ...input.comparisonModels.flatMap((item) => item.featureKeys)]),
  ];
  const quarterSamples = [...train, ...test].map((quarter) =>
    buildQuarterSamples(input.seriesList, quarter, sampleKeys, input.minStoreCount),
  );
  const trainSamples = quarterSamples.filter((item) => train.includes(item.quarter)).flatMap((item) => item.samples);
  const testSamples = quarterSamples.filter((item) => test.includes(item.quarter)).flatMap((item) => item.samples);
  if (trainSamples.length === 0 || testSamples.length === 0)
    throw new Error(`${input.industryCode}: 학습 또는 테스트 표본이 없습니다.`);

  const fitFor = (featureKeys: readonly FeatureKey[]) =>
    fitIndustryModel({
      industryCode: input.industryCode,
      industryName: input.industryName,
      featureKeys,
      train,
      test,
      trainSamples,
      testSamples,
    });

  const primary = fitFor(input.featureKeys);
  const comparisons = input.comparisonModels.map((item) => {
    const { model } = fitFor(item.featureKeys);
    return {
      id: item.id,
      label: item.label,
      model,
      evaluation: evaluateModel(model, testSamples, input.gradeBoundaries),
    };
  });

  const correlations: IndustryTrainingResult['correlations'] = [];
  for (let i = 0; i < input.featureKeys.length; i++) {
    for (let j = i + 1; j < input.featureKeys.length; j++) {
      const left = input.featureKeys[i];
      const right = input.featureKeys[j];
      correlations.push({
        left,
        right,
        r: pearson(
          trainSamples.map((sample) => sample.features[left]),
          trainSamples.map((sample) => sample.features[right]),
        ),
      });
    }
  }

  return {
    model: primary.model,
    evaluation: evaluateModel(primary.model, testSamples, input.gradeBoundaries),
    quarterSamples,
    correlations,
    comparisons,
    converged: primary.converged,
    iterations: primary.iterations,
  };
}

// 등급이 낮아질수록(AAA → D) 실제 고폐업 비율이 줄지 않는지. 표본이 minCount보다 적은 등급은 건너뛴다.
export function isMonotonic(outcomes: readonly GradeOutcome[], minCount = 1): boolean {
  const rates = outcomes
    .filter((item) => item.count >= minCount)
    .map((item) => item.highClosureRate)
    .filter((rate): rate is number => rate !== null);
  return rates.every((rate, i) => i === 0 || rate >= rates[i - 1]);
}

export type QuarterScore = { series: AreaSeries; storeCount: number; scored: ScoredRow };

export function scoreQuarter(input: {
  model: IndustryModel;
  seriesList: readonly AreaSeries[];
  quarter: string;
  minStoreCount: number;
  gradeBoundaries: MarketScoreModel['gradeBoundaries'];
}): { scores: QuarterScore[]; exclusions: Record<ExclusionReason, number> } {
  const exclusions: Record<ExclusionReason, number> = {
    NO_DATA: 0,
    FEW_STORES: 0,
    NO_SALES: 0,
    NO_PRIOR_SALES: 0,
    INCOMPLETE_WINDOW: 0,
    FEATURE_UNAVAILABLE: 0,
  };
  const featureKeys = input.model.features.map((feature) => feature.key);
  const scores: QuarterScore[] = [];
  for (const series of input.seriesList) {
    const row = buildFeatureRow(series, input.quarter, featureKeys, input.minStoreCount);
    if (row.status === 'EXCLUDED') {
      exclusions[row.reason]++;
      continue;
    }
    scores.push({
      series,
      storeCount: row.storeCount,
      scored: scoreFeatures(input.model, row.features, input.gradeBoundaries),
    });
  }
  return { scores, exclusions };
}
