import type { ZodError } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { listFundingMatches, type FundingMatchesWithProfile } from '../funding/match-list.ts';
import { readStoredFundingProfile, withBusinessDistrict, type DistrictSource } from '../funding/match-profile.ts';

// 계획에 저장된 자금 조건으로 맞춰 본 결과(ADR 0009 §4). 페이지 단위 조회와 같은 listFundingMatches를 부르고, 어느
// 계획·revision의 조건이었는지와 맞춰 본 자치구가 어디서 왔는지를 더한다.
export type PlanFundingMatchesResponse = FundingMatchesWithProfile & {
  plan: { id: string; revision: number };
  districtSource: DistrictSource;
};

export type PlanFundingMatchesOutcome =
  | { kind: 'OK'; payload: PlanFundingMatchesResponse }
  | { kind: 'PROFILE_MISSING' }
  | { kind: 'PROFILE_INVALID'; error: ZodError }
  | { kind: 'CATALOG_UNAVAILABLE' };

export type PlanFundingProfileRecord = {
  id: string;
  revision: number;
  fundingProfileJson: unknown;
  businessProfileJson: unknown;
};

// 저장된 자금 조건이 없거나 어느 모양에도 맞지 않으면 맞춰 보지 않는다. 없는 조건을 빈 입력으로 대신 채우지 않는다.
// 예전 모양(업종·용도가 있던 조건)은 읽을 때 사업 단계·자치구만 옮긴다(match-profile.ts). 자치구가 비어 있으면 서버가
// 계획의 사업 프로필에서 정한다.
export async function matchFundingForPlan(
  prisma: PrismaClient,
  plan: PlanFundingProfileRecord,
  options: { asOfDate: string },
): Promise<PlanFundingMatchesOutcome> {
  const stored = readStoredFundingProfile(plan.fundingProfileJson);
  if (stored.kind === 'NONE') return { kind: 'PROFILE_MISSING' };
  if (stored.kind === 'INVALID') return { kind: 'PROFILE_INVALID', error: stored.error };

  const { profile, districtSource } = withBusinessDistrict(stored.profile, plan.businessProfileJson);
  const outcome = await listFundingMatches(prisma, profile, { asOfDate: options.asOfDate });
  if (outcome.kind === 'CATALOG_UNAVAILABLE') return { kind: 'CATALOG_UNAVAILABLE' };

  return {
    kind: 'OK',
    payload: { ...outcome.payload, profile, plan: { id: plan.id, revision: plan.revision }, districtSource },
  };
}
