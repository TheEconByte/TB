import { z } from 'zod';
import type { PrismaClient } from '@/generated/prisma/client';
import { revenueOutlier, type ScoreSummary } from '@/features/market/score/build';
import { GRADES } from '@/features/market/score/config';
import { supportedIndustry } from '@/features/market/types';

// /markets의 [이 상권으로 재무 계획 시작]으로 만든 계획에 붙이는 상권 점수 스냅샷(ADR 0008).
// 화면은 참조만 보내고, 등급·월매출 기본값은 서버가 점수 릴리스에서 다시 읽어 저장한다.
// 재무 입력(inputJson)과 분리해 계산 키와 저장된 결과를 바꾸지 않는다.

export const marketScoreReferenceSchema = z.object({
  releaseKey: z.string().regex(/^[a-z0-9-]{1,120}$/),
  areaType: z.string().regex(/^[A-Z]{1,4}$/),
  areaCode: z.string().regex(/^\d{7}$/),
  industryCode: z.string().regex(/^[A-Z]{2}\d{6}$/),
});

export const PLAN_MARKET_SCORE_VERSION = 'plan-market-score-v1';

export const planMarketScoreSchema = z.object({
  schemaVersion: z.literal(PLAN_MARKET_SCORE_VERSION),
  releaseKey: z.string(),
  modelVersion: z.string(),
  marketReleaseKey: z.string(),
  baseQuarter: z.string(),
  areaType: z.string(),
  areaCode: z.string(),
  areaName: z.string(),
  districtCode: z.string(),
  districtName: z.string(),
  industryCode: z.string(),
  industryName: z.string(),
  score: z.number().int().min(0).max(100),
  grade: z.enum(GRADES),
  // 원 단위 정수 문자열. 잠정 값이며 사용자가 재무 입력에서 고칠 수 있다.
  monthlyRevenueDefault: z.string().regex(/^\d+$/),
  monthlyRevenueBasis: z.string(),
  // 같은 업종 하위·상위 1% 경계 밖의 기본값이었는지(화면 경고용)
  monthlyRevenueUnusual: z.boolean(),
  savedAt: z.string(),
});

export type MarketScoreReference = z.infer<typeof marketScoreReferenceSchema>;
export type PlanMarketScore = z.infer<typeof planMarketScoreSchema>;

export function parsePlanMarketScore(value: unknown): PlanMarketScore | null {
  if (value === null || value === undefined) return null;
  const parsed = planMarketScoreSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// 활성이었거나 지금 활성인 점수 릴리스만 받는다. 점수를 낸 상권이 아니면 null이다.
export async function resolvePlanMarketScore(
  prisma: PrismaClient,
  reference: MarketScoreReference,
  now: Date = new Date(),
): Promise<PlanMarketScore | null> {
  const release = await prisma.marketScoreRelease.findUnique({ where: { releaseKey: reference.releaseKey } });
  if (!release || (release.status !== 'ACTIVE' && release.status !== 'SUPERSEDED')) return null;
  const row = await prisma.marketScore.findUnique({
    where: {
      releaseId_industryCode_areaType_areaCode: {
        releaseId: release.id,
        industryCode: reference.industryCode,
        areaType: reference.areaType,
        areaCode: reference.areaCode,
      },
    },
  });
  if (!row || row.status !== 'SCORED' || row.score === null || row.grade === null || !row.monthlyRevenueDefault) {
    return null;
  }
  const area = await prisma.marketArea.findUnique({
    where: {
      releaseId_areaType_areaCode: {
        releaseId: release.marketReleaseId,
        areaType: reference.areaType,
        areaCode: reference.areaCode,
      },
    },
  });
  if (!area) return null;
  const warningRange =
    (release.summaryJson as unknown as ScoreSummary).industries.find(
      (industry) => industry.industryCode === reference.industryCode,
    )?.monthlyRevenueWarningRange ?? null;
  return planMarketScoreSchema.parse({
    schemaVersion: PLAN_MARKET_SCORE_VERSION,
    releaseKey: release.releaseKey,
    modelVersion: release.modelVersion,
    marketReleaseKey: release.marketReleaseKey,
    baseQuarter: release.baseQuarter,
    areaType: area.areaType,
    areaCode: area.areaCode,
    areaName: area.sourceName,
    districtCode: area.districtCode,
    districtName: area.districtName,
    industryCode: reference.industryCode,
    industryName: supportedIndustry(reference.industryCode)?.displayName ?? reference.industryCode,
    score: row.score,
    grade: row.grade,
    monthlyRevenueDefault: row.monthlyRevenueDefault.toFixed(0),
    monthlyRevenueBasis: 'ADR 0002 잠정 해석: 최근 4분기 매출 원값 합 ÷ 같은 기간 점포 수 합(점포당 월평균)',
    monthlyRevenueUnusual: revenueOutlier(row.monthlyRevenueDefault.toFixed(0), warningRange) !== null,
    savedAt: now.toISOString(),
  });
}
