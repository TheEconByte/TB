import type { ZodError } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import {
  fundingCandidateRequestSchema,
  listFundingCandidates,
  type FundingCandidatesResponse,
} from '../funding/candidates.ts';
import type { FundingProfile } from '../funding/eligibility.ts';

// 계획에 저장된 조건으로 판정한 결과. F4-2의 페이지 단위 판정 페이로드에 어느
// 계획·revision의 조건이었는지를 더한다. 판정 자체는 페이지 단위 조회와 같은
// listFundingCandidates를 그대로 호출한다.
export type PlanFundingMatchesResponse = FundingCandidatesResponse & {
  plan: { id: string; revision: number };
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
};

// 저장된 프로필이 없거나 현재 스키마와 맞지 않으면 판정하지 않는다. 없는 조건을
// UNKNOWN 프로필로 대신 채우지 않는다.
export async function matchFundingForPlan(
  prisma: PrismaClient,
  plan: PlanFundingProfileRecord,
  options: { asOfDate: string },
): Promise<PlanFundingMatchesOutcome> {
  if (plan.fundingProfileJson === null || plan.fundingProfileJson === undefined) return { kind: 'PROFILE_MISSING' };
  const parsed = fundingCandidateRequestSchema.safeParse(plan.fundingProfileJson);
  if (!parsed.success) return { kind: 'PROFILE_INVALID', error: parsed.error };

  const profile: FundingProfile = parsed.data;
  const outcome = await listFundingCandidates(prisma, profile, { asOfDate: options.asOfDate });
  if (outcome.kind === 'CATALOG_UNAVAILABLE') return { kind: 'CATALOG_UNAVAILABLE' };

  return { kind: 'OK', payload: { ...outcome.payload, plan: { id: plan.id, revision: plan.revision } } };
}
