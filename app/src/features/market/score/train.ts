import { quartersBetween, shiftQuarter } from '../quarter.ts';
import {
  GROWTH_LAG_QUARTERS,
  LABEL_HORIZON_QUARTERS,
  PER_STORE_WINDOW_QUARTERS,
  SURVIVAL_MODEL_LABEL,
  TEST_QUARTER_COUNT,
  Z_CLIP,
  type ComparisonModelId,
  type FeatureKey,
  type Grade,
} from './config.ts';
import {
  FEATURE_DEFINITIONS,
  areaKeyOf,
  buildFeatureRow,
  futureClosureRate,
  groupSeriesByArea,
  labelsByMedian,
  type AreaSeries,
  type ExclusionReason,
} from './dataset.ts';
import {
  areaUnderCurve,
  fitLogistic,
  fitPooledLogistic,
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
// seriesByArea는 상권별 요식업 업종 시계열(groupSeriesByArea)이며 상권 변수를 쓸 때 넘긴다.
export function buildQuarterSamples(
  seriesList: readonly AreaSeries[],
  quarter: string,
  featureKeys: readonly FeatureKey[],
  minStoreCount: number,
  seriesByArea: ReadonlyMap<string, readonly AreaSeries[]> | null = null,
): QuarterSamples {
  const exclusions = emptyExclusions();
  const pending: Omit<TrainingSample, 'label'>[] = [];
  for (const series of seriesList) {
    const area = seriesByArea?.get(areaKeyOf(series)) ?? null;
    const row = buildFeatureRow(series, quarter, featureKeys, minStoreCount, area);
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
  // 계수 파일에 저장하는 생존점수 모델(부분 통합 학습)
  model: IndustryModel;
  evaluation: ModelEvaluation;
  quarterSamples: QuarterSamples[];
  correlations: { left: FeatureKey; right: FeatureKey; r: number }[];
  // 비교 모델(업종별 학습)과 채택 모델(survival)
  comparisons: ComparisonResult[];
  // 부분 통합 학습 전체의 IRLS 반복 수·수렴 여부(업종마다 같다)
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

type IndustrySamples = {
  industryCode: string;
  industryName: string;
  train: string[];
  test: string[];
  trainSamples: readonly TrainingSample[];
  testSamples: readonly TrainingSample[];
};

type Scaling = { mean: number; std: number }[];

function scalingFor(featureKeys: readonly FeatureKey[], samples: readonly TrainingSample[]): Scaling {
  return featureKeys.map((key) => meanAndStd(samples.map((sample) => sample.features[key])));
}

function standardized(featureKeys: readonly FeatureKey[], scaling: Scaling, sample: TrainingSample): number[] {
  return featureKeys.map((key, j) => clippedZ(sample.features[key], scaling[j].mean, scaling[j].std, Z_CLIP));
}

// 학습한 절편·계수·표준오차로 계수 파일의 업종 모델을 만든다. 업종별 학습과 부분 통합 학습이 함께 쓴다.
function industryModelFrom(
  input: IndustrySamples & {
    featureKeys: readonly FeatureKey[];
    scaling: Scaling;
    intercept: number;
    coefficients: readonly number[];
    standardErrors: readonly number[];
  },
): IndustryModel {
  const { featureKeys, scaling, trainSamples, testSamples } = input;
  const predict = (sample: TrainingSample) =>
    sigmoid(
      standardized(featureKeys, scaling, sample).reduce(
        (sum, value, j) => sum + value * input.coefficients[j],
        input.intercept,
      ),
    );
  const auc = (samples: readonly TrainingSample[]) =>
    areaUnderCurve(
      samples.map(predict),
      samples.map((sample) => sample.label),
    );
  return {
    industryCode: input.industryCode,
    industryName: input.industryName,
    intercept: input.intercept,
    features: featureKeys.map((key, j) => ({
      key,
      label: FEATURE_DEFINITIONS[key].label,
      definition: FEATURE_DEFINITIONS[key].definition,
      expectedScoreDirection: FEATURE_DEFINITIONS[key].expectedScoreDirection,
      beta: input.coefficients[j],
      standardError: input.standardErrors[j],
      pValue: waldPValue(input.coefficients[j], input.standardErrors[j]),
      mean: scaling[j].mean,
      std: scaling[j].std,
    })),
    trainQuarters: input.train,
    testQuarters: input.test,
    trainSize: trainSamples.length,
    testSize: testSamples.length,
    trainPositiveRate: positiveRate(trainSamples),
    testPositiveRate: positiveRate(testSamples),
    trainAuc: auc(trainSamples),
    testAuc: auc(testSamples),
    zClip: Z_CLIP,
  };
}

// 업종 하나만으로 학습한다(비교 모델).
function fitIndustryModel(input: IndustrySamples & { featureKeys: readonly FeatureKey[] }): IndustryModel {
  const scaling = scalingFor(input.featureKeys, input.trainSamples);
  const fit = fitLogistic(
    input.trainSamples.map((sample) => standardized(input.featureKeys, scaling, sample)),
    input.trainSamples.map((sample) => sample.label),
  );
  return industryModelFrom({
    ...input,
    scaling,
    intercept: fit.coefficients[0],
    coefficients: fit.coefficients.slice(1),
    standardErrors: fit.standardErrors.slice(1),
  });
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

// 요식업 업종들의 생존점수 모델을 학습한다(ADR 0008, 모델 정의 v4). 채택 모델은 부분 통합으로 함께 학습하고,
// 비교 모델은 같은 학습·테스트 행으로 업종마다 따로 학습한다. 상권 변수는 입력 업종 전체로 상권을 묶어 계산한다.
export function trainScoreModels(input: {
  industries: readonly { industryCode: string; industryName: string; seriesList: readonly AreaSeries[] }[];
  dataStart: string;
  dataEnd: string;
  featureKeys: readonly FeatureKey[];
  comparisonModels: readonly { id: ComparisonModelId; label: string; featureKeys: readonly FeatureKey[] }[];
  deviationPenalty: number;
  minStoreCount: number;
  gradeBoundaries: MarketScoreModel['gradeBoundaries'];
}): IndustryTrainingResult[] {
  const { train, test } = splitByTime(labelledBaseQuarters(input.dataStart, input.dataEnd));
  const seriesByArea = groupSeriesByArea(input.industries.map((industry) => industry.seriesList));
  const sampleKeys = [
    ...new Set([...input.featureKeys, ...input.comparisonModels.flatMap((item) => item.featureKeys)]),
  ];
  const prepared = input.industries.map((industry) => {
    const quarterSamples = [...train, ...test].map((quarter) =>
      buildQuarterSamples(industry.seriesList, quarter, sampleKeys, input.minStoreCount, seriesByArea),
    );
    const pick = (quarters: string[]) =>
      quarterSamples.filter((item) => quarters.includes(item.quarter)).flatMap((item) => item.samples);
    const samples: IndustrySamples = {
      industryCode: industry.industryCode,
      industryName: industry.industryName,
      train,
      test,
      trainSamples: pick(train),
      testSamples: pick(test),
    };
    if (samples.trainSamples.length === 0 || samples.testSamples.length === 0)
      throw new Error(`${industry.industryCode}: 학습 또는 테스트 표본이 없습니다.`);
    return { samples, quarterSamples, scaling: scalingFor(input.featureKeys, samples.trainSamples) };
  });

  const pooled = fitPooledLogistic(
    prepared.map(({ samples, scaling }) => ({
      features: samples.trainSamples.map((sample) => standardized(input.featureKeys, scaling, sample)),
      labels: samples.trainSamples.map((sample) => sample.label),
    })),
    input.deviationPenalty,
  );

  return prepared.map(({ samples, quarterSamples, scaling }, index) => {
    const model = industryModelFrom({
      ...samples,
      featureKeys: input.featureKeys,
      scaling,
      ...pooled.groups[index],
    });
    const evaluation = evaluateModel(model, samples.testSamples, input.gradeBoundaries);
    const comparisons: ComparisonResult[] = [
      ...input.comparisonModels.map((item) => {
        const comparison = fitIndustryModel({ ...samples, featureKeys: item.featureKeys });
        return {
          id: item.id,
          label: item.label,
          model: comparison,
          evaluation: evaluateModel(comparison, samples.testSamples, input.gradeBoundaries),
        };
      }),
      { id: 'survival', label: SURVIVAL_MODEL_LABEL, model, evaluation },
    ];

    const correlations: IndustryTrainingResult['correlations'] = [];
    for (let i = 0; i < input.featureKeys.length; i++) {
      for (let j = i + 1; j < input.featureKeys.length; j++) {
        const left = input.featureKeys[i];
        const right = input.featureKeys[j];
        correlations.push({
          left,
          right,
          r: pearson(
            samples.trainSamples.map((sample) => sample.features[left]),
            samples.trainSamples.map((sample) => sample.features[right]),
          ),
        });
      }
    }

    return {
      model,
      evaluation,
      quarterSamples,
      correlations,
      comparisons,
      converged: pooled.converged,
      iterations: pooled.iterations,
    };
  });
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

// seriesByArea는 상권별 요식업 업종 시계열(groupSeriesByArea)이다.
export function scoreQuarter(input: {
  model: IndustryModel;
  seriesList: readonly AreaSeries[];
  seriesByArea: ReadonlyMap<string, readonly AreaSeries[]>;
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
    const area = input.seriesByArea.get(areaKeyOf(series)) ?? null;
    const row = buildFeatureRow(series, input.quarter, featureKeys, input.minStoreCount, area);
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
