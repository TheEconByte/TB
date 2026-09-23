import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { todayInKst } from './dates.ts';
import { evaluateCandidates, type FundingCandidateList, type FundingProfile } from './eligibility.ts';
import { findActiveFundingCatalog } from './read.ts';
import { BUSINESS_STAGES, INDUSTRY_CODE_PATTERN, PURPOSES } from './types.ts';

// 사용자가 지금 입력하는 사업단계·자치구·업종·용도. 상품의 판정 함수가 쓰는
// FundingProfile과 같은 모양이며, 판단하지 않은 값은 UNKNOWN/null로 남긴다.
export const fundingCandidateRequestSchema = z.strictObject({
  businessStage: z.union([z.enum(BUSINESS_STAGES), z.literal('UNKNOWN')]),
  districtCode: z
    .string()
    .regex(/^\d{5}$/, '자치구 코드는 숫자 5자리여야 합니다.')
    .nullable(),
  industryCode: z.string().regex(INDUSTRY_CODE_PATTERN, '업종 코드는 CS100001 형식이어야 합니다.').nullable(),
  purpose: z.union([z.enum(PURPOSES), z.literal('UNKNOWN')]),
});

export type FundingCandidateRequest = z.infer<typeof fundingCandidateRequestSchema>;

export type FundingCandidatesRelease = {
  catalogKey: string;
  catalogVersion: string;
  schemaVersion: string;
  basisDate: string;
  reviewedAt: string | null;
  activatedAt: string | null;
  reviewer: string;
  productCount: number;
};

export type FundingCandidatesResponse = FundingCandidateList & { release: FundingCandidatesRelease };

export type FundingCandidatesOutcome =
  { kind: 'OK'; payload: FundingCandidatesResponse } | { kind: 'CATALOG_UNAVAILABLE' };

// 활성 카탈로그가 없으면 빈 후보가 아니라 CATALOG_UNAVAILABLE이다. 후보 0건은
// 카탈로그가 있고 상품이 전부 제외·추가 확인일 때만 나오는 정상 상태다.
export async function listFundingCandidates(
  prisma: PrismaClient,
  profile: FundingProfile,
  options: { asOfDate?: string } = {},
): Promise<FundingCandidatesOutcome> {
  const active = await findActiveFundingCatalog(prisma);
  if (!active) return { kind: 'CATALOG_UNAVAILABLE' };

  // 판정 기준일은 호출자가 정한다. 웹 요청은 서버의 한국 시간 날짜를 넘기고,
  // 테스트는 고정 날짜를 넘긴다.
  const asOfDate = options.asOfDate ?? todayInKst();
  const list = evaluateCandidates(active.catalog, profile, { asOfDate });

  return {
    kind: 'OK',
    payload: {
      ...list,
      release: {
        catalogKey: active.catalogKey,
        catalogVersion: active.catalogVersion,
        schemaVersion: active.schemaVersion,
        basisDate: active.basisDate,
        reviewedAt: active.reviewedAt,
        activatedAt: active.activatedAt,
        reviewer: active.reviewer,
        productCount: active.productCount,
      },
    },
  };
}
