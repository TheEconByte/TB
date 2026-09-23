import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/prisma/client';
import { calculateFinance } from '@/features/finance/calculate';
import { financeInputSchema } from '@/features/finance/schema';
import { CALCULATION_VERSION } from '@/features/finance/types';
import { calculationKey } from '@/features/plans/calculation-key';
import { planLoanAssumptionSchema } from '@/features/plans/loan-assumption';
import { apiError, internalError } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';
import { guardMutationRequest } from '@/lib/request-security';
import { consumeRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ planId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const blocked = guardMutationRequest(request);
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const limit = consumeRateLimit(`calculation:${user.id}`, { max: 20, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const { planId } = await context.params;
    const prisma = getPrisma();
    const plan = await prisma.plan.findFirst({ where: { id: planId, userId: user.id } });
    if (!plan) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
    const parsedInput = financeInputSchema.safeParse(plan.inputJson);
    if (!parsedInput.success)
      return apiError(
        400,
        'INVALID_INPUT',
        '저장된 초안 입력이 현재 스키마와 맞지 않습니다.',
        parsedInput.error.flatten(),
      );

    const key = calculationKey(plan.id, plan.revision, plan.inputSchemaVersion, CALCULATION_VERSION);
    const existing = await prisma.planResult.findUnique({ where: { calculationKey: key } });
    if (existing) return NextResponse.json({ result: existing, reused: true });

    const calculated = calculateFinance(parsedInput.data);
    // 상품 확정 조건을 적용한 대출 가정이면 그 출처를 결과에 함께 남긴다. 저장된 값이
    // 현재 스키마와 맞지 않으면 상품 조건으로 표시하지 않는다.
    const storedAssumption = planLoanAssumptionSchema.safeParse(plan.loanAssumptionJson);
    const resultAssumption = storedAssumption.success ? storedAssumption.data : null;
    try {
      const result = await prisma.planResult.create({
        data: {
          planId: plan.id,
          inputRevision: plan.revision,
          inputSchemaVersion: plan.inputSchemaVersion,
          inputSnapshot: parsedInput.data as Prisma.InputJsonValue,
          resultJson: calculated as unknown as Prisma.InputJsonValue,
          calculationVersion: CALCULATION_VERSION,
          calculationKey: key,
          loanAssumptionJson: resultAssumption === null ? Prisma.DbNull : (resultAssumption as Prisma.InputJsonValue),
        },
      });
      return NextResponse.json({ result, reused: false }, { status: 201 });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        const result = await prisma.planResult.findUnique({ where: { calculationKey: key } });
        if (result) return NextResponse.json({ result, reused: true });
      }
      throw error;
    }
  } catch (error) {
    return internalError(error);
  }
}
