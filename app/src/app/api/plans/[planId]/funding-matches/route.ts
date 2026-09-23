import { NextResponse } from 'next/server';
import { todayInKst } from '@/features/funding/dates';
import { matchFundingForPlan } from '@/features/plans/funding-matches';
import { apiError, internalError } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';
import { guardMutationRequest } from '@/lib/request-security';
import { consumeRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ planId: string }> };

// 저장된 계획 조건으로 자금 후보를 판정한다. 인증·소유자·오류 패턴은
// /api/plans/{id}/calculations와 같다: 미로그인 401, 없거나 타인 소유 404,
// 저장된 조건이 없거나 스키마와 다르면 400, 활성 카탈로그가 없으면 503이다.
// 판정 기준일은 서버의 한국 시간 오늘이며 요청 본문으로 바꿀 수 없다.
export async function POST(request: Request, context: Context) {
  try {
    const blocked = guardMutationRequest(request);
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const limit = consumeRateLimit(`funding-matches:${user.id}`, { max: 60, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const { planId } = await context.params;
    const prisma = getPrisma();
    const plan = await prisma.plan.findFirst({
      where: { id: planId, userId: user.id },
      select: { id: true, revision: true, fundingProfileJson: true },
    });
    if (!plan) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');

    const outcome = await matchFundingForPlan(prisma, plan, { asOfDate: todayInKst() });
    if (outcome.kind === 'PROFILE_MISSING') {
      return apiError(
        400,
        'INVALID_INPUT',
        '이 계획에는 저장된 자금 조건이 없습니다. 사업 단계·자치구·업종·용도를 저장한 뒤 다시 조회해 주세요.',
      );
    }
    if (outcome.kind === 'PROFILE_INVALID') {
      return apiError(400, 'INVALID_INPUT', '저장된 자금 조건이 현재 스키마와 맞지 않습니다.', outcome.error.flatten());
    }
    if (outcome.kind === 'CATALOG_UNAVAILABLE') {
      return apiError(
        503,
        'CATALOG_UNAVAILABLE',
        '활성 자금 카탈로그 릴리스가 없습니다. 운영자가 검수한 카탈로그를 적재해야 후보를 조회할 수 있습니다.',
      );
    }
    return NextResponse.json(outcome.payload);
  } catch (error) {
    return internalError(error);
  }
}
