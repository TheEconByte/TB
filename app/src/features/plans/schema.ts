import { z } from 'zod';
import { financeInputSchema } from '@/features/finance/schema';
import { fundingCandidateRequestSchema } from '@/features/funding/candidates';
import { businessProfileInputSchema } from '@/features/business-profile/schema';

// 자금 후보 조건은 페이지 단위 조회와 같은 스키마(F4-2의 fundingCandidateRequestSchema)를
// 그대로 재사용한다. 화면 입력과 계획에 저장한 조건이 서로 어긋나지 않게 하기 위해서다.
// 재무 계산 입력(input)과 분리되어 있어 INPUT_SCHEMA_VERSION과 계산 키는 바뀌지 않는다.
export const planWriteSchema = z.object({
  title: z.string().trim().min(1, '계획 제목을 입력해 주세요.').max(100, '계획 제목은 100자 이하여야 합니다.'),
  input: financeInputSchema,
  // 선택 항목이다. 값이 없으면 프로필 없는 계획으로 남고, null이면 저장된 조건을 지운다.
  fundingProfile: fundingCandidateRequestSchema.nullable().optional(),
  businessProfile: businessProfileInputSchema.nullable().optional(),
});

export const planUpdateSchema = planWriteSchema.extend({
  revision: z.number().int().positive(),
});

export type PlanWriteInput = z.infer<typeof planWriteSchema>;

export type PlanFundingProfile = NonNullable<PlanWriteInput['fundingProfile']>;
