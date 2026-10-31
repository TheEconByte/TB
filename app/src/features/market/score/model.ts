import { z } from 'zod';
import { GRADES, type FeatureKey, type Grade } from './config.ts';
import { sigmoid } from './logistic.ts';

// score:train이 쓰고 score:build·API가 읽는 계수 파일(app/models/market-score/<버전>.json).
const featureKeySchema = z.enum([
  'salesGrowth',
  'salesPerStore',
  'storeCount',
  'pastClosureRate',
  'pastOpenRate',
  'franchiseShare',
]);

const featureCoefficientSchema = z.object({
  key: featureKeySchema,
  label: z.string().min(1),
  definition: z.string().min(1),
  expectedScoreDirection: z.union([z.literal(1), z.literal(0), z.literal(-1)]),
  // 고폐업 확률 기준 표준화 계수. 점수 기여도는 −beta × z다.
  beta: z.number(),
  standardError: z.number(),
  pValue: z.number(),
  // 학습셋 표준화 값
  mean: z.number(),
  std: z.number().positive(),
});

const industryModelSchema = z.object({
  industryCode: z.string().min(1),
  industryName: z.string().min(1),
  intercept: z.number(),
  features: z.array(featureCoefficientSchema).min(1),
  trainQuarters: z.array(z.string()).min(1),
  testQuarters: z.array(z.string()).min(1),
  trainSize: z.number().int().positive(),
  testSize: z.number().int().positive(),
  trainPositiveRate: z.number(),
  testPositiveRate: z.number(),
  trainAuc: z.number(),
  testAuc: z.number(),
  // 학습과 점수 계산 모두 표준화 값을 ±zClip에서 자른다.
  zClip: z.number().positive(),
});

export const marketScoreModelSchema = z.object({
  version: z.string().regex(/^[a-z0-9-]+$/),
  definitionVersion: z.string().min(1),
  createdAt: z.string().min(1),
  marketReleaseKey: z.string().min(1),
  dataPeriod: z.object({ start: z.string(), end: z.string() }),
  minStoreCount: z.number().int().positive(),
  gradeBoundaries: z.array(z.object({ grade: z.enum(GRADES), minScore: z.number().int().min(0).max(100) })).length(8),
  industries: z.array(industryModelSchema).min(1),
});

export type MarketScoreModel = z.infer<typeof marketScoreModelSchema>;
export type IndustryModel = z.infer<typeof industryModelSchema>;

export type FeatureContribution = {
  key: FeatureKey;
  label: string;
  value: number;
  z: number;
  // 점수 기준. +이면 점수를 올린 변수다.
  contribution: number;
};

export type ScoredRow = {
  probability: number;
  score: number;
  grade: Grade;
  // 기여도 절댓값이 큰 순서
  contributions: FeatureContribution[];
};

export function gradeForScore(score: number, boundaries: MarketScoreModel['gradeBoundaries']): Grade {
  const sorted = [...boundaries].sort((a, b) => b.minScore - a.minScore);
  for (const boundary of sorted) if (score >= boundary.minScore) return boundary.grade;
  return sorted[sorted.length - 1].grade;
}

export function clippedZ(value: number, mean: number, std: number, clip: number): number {
  return Math.max(-clip, Math.min(clip, (value - mean) / std));
}

export function scoreFeatures(
  model: IndustryModel,
  // 모델이 쓰는 변수만 있으면 된다.
  features: Readonly<Partial<Record<FeatureKey, number>>>,
  boundaries: MarketScoreModel['gradeBoundaries'],
): ScoredRow {
  let logit = model.intercept;
  const contributions: FeatureContribution[] = model.features.map((feature) => {
    const value = features[feature.key];
    if (value === undefined) throw new Error(`${feature.label} 값이 없어 점수를 계산할 수 없습니다.`);
    const z = clippedZ(value, feature.mean, feature.std, model.zClip);
    logit += feature.beta * z;
    return { key: feature.key, label: feature.label, value, z, contribution: -feature.beta * z };
  });
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const probability = sigmoid(logit);
  const score = Math.round((1 - probability) * 100);
  return { probability, score, grade: gradeForScore(score, boundaries), contributions };
}

export function industryModel(model: MarketScoreModel, industryCode: string): IndustryModel | null {
  return model.industries.find((item) => item.industryCode === industryCode) ?? null;
}

export function modelFeatureKeys(model: IndustryModel): FeatureKey[] {
  return model.features.map((feature) => feature.key);
}
