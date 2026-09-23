import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/prisma/client';
import { INPUT_SCHEMA_VERSION } from '@/features/finance/types';
import { planFundingProfileJson } from '@/features/plans/funding-profile';
import { retainedLoanAssumption } from '@/features/plans/loan-assumption';
import { resolveBusinessProfile } from '@/features/business-profile/resolve';
import { planUpdateSchema } from '@/features/plans/schema';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';
import { guardMutationRequest } from '@/lib/request-security';
import { consumeRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ planId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const limit = consumeRateLimit(`plan-update:${user.id}`, { max: 60, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const { planId } = await context.params;
    const plan = await getPrisma().plan.findFirst({
      where: { id: planId, userId: user.id },
      include: {
        results: {
          orderBy: { calculatedAt: 'desc' },
          select: { id: true, inputRevision: true, calculationVersion: true, calculatedAt: true },
        },
      },
    });
    if (!plan) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
    return NextResponse.json({ plan });
  } catch (error) {
    return internalError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const blocked = guardMutationRequest(request, { requireJson: true });
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const limit = consumeRateLimit(`plan-delete:${user.id}`, { max: 30, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const parsed = planUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return invalidZod(parsed.error);
    const { planId } = await context.params;
    const prisma = getPrisma();
    // 자금 프로필은 선택 항목이다. 본문에 키가 있으면 저장하거나(null이면 비움),
    // 키가 없으면 이 요청 전에 저장된 조건을 그대로 둔다. 프로필이 없는 기존
    // 계획의 수정이 여전히 유효해야 하기 때문이다.
    const includesFundingProfile = Object.prototype.hasOwnProperty.call(parsed.data, 'fundingProfile');
    const includesBusinessProfile = Object.prototype.hasOwnProperty.call(parsed.data, 'businessProfile');
    // 대출 가정의 출처는 서버가 판단한다. 새 입력이 저장된 상품 확정 조건과 값까지
    // 같으면 출처를 유지하고, 직접 값을 바꾸면 상품 조건으로 표시하지 않도록 지운다.
    const stored = await prisma.plan.findFirst({
      where: { id: planId, userId: user.id },
      select: { loanAssumptionJson: true },
    });
    if (!stored) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
    const retainedAssumption = retainedLoanAssumption(stored.loanAssumptionJson, parsed.data.input.newLoan);
    const resolvedBusiness =
      !includesBusinessProfile || parsed.data.businessProfile == null
        ? null
        : await resolveBusinessProfile(prisma, parsed.data.businessProfile);
    if (resolvedBusiness && resolvedBusiness.kind !== 'OK') {
      return apiError(
        409,
        'BUSINESS_PROFILE_UNAVAILABLE',
        '선택한 사업 조건을 현재 활성 데이터 릴리스에서 확인하지 못했습니다.',
      );
    }
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.plan.updateMany({
        where: { id: planId, userId: user.id, revision: parsed.data.revision },
        data: {
          title: parsed.data.title,
          inputJson: parsed.data.input as Prisma.InputJsonValue,
          inputSchemaVersion: INPUT_SCHEMA_VERSION,
          ...(includesFundingProfile ? { fundingProfileJson: planFundingProfileJson(parsed.data.fundingProfile) } : {}),
          ...(includesBusinessProfile
            ? {
                businessProfileJson:
                  parsed.data.businessProfile === null
                    ? Prisma.DbNull
                    : resolvedBusiness && resolvedBusiness.kind === 'OK'
                      ? (resolvedBusiness.profile as Prisma.InputJsonValue)
                      : Prisma.DbNull,
              }
            : {}),
          loanAssumptionJson:
            retainedAssumption === null ? Prisma.DbNull : (retainedAssumption as Prisma.InputJsonValue),
          revision: { increment: 1 },
        },
      });
      if (changed.count === 1) return tx.plan.findUniqueOrThrow({ where: { id: planId } });
      const exists = await tx.plan.findFirst({ where: { id: planId, userId: user.id }, select: { revision: true } });
      return exists ? { conflict: true as const, revision: exists.revision } : null;
    });
    if (!result) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
    if ('conflict' in result)
      return apiError(409, 'REVISION_CONFLICT', '다른 화면에서 계획이 먼저 수정되었습니다.', {
        currentRevision: result.revision,
      });
    return NextResponse.json({ plan: result });
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'INVALID_INPUT', '올바른 JSON 요청이 아닙니다.');
    return internalError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const blocked = guardMutationRequest(request);
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const { planId } = await context.params;
    const deleted = await getPrisma().plan.deleteMany({ where: { id: planId, userId: user.id } });
    if (deleted.count === 0) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return internalError(error);
  }
}
