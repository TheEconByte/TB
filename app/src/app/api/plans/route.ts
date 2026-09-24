import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/prisma/client';
import { INPUT_SCHEMA_VERSION } from '@/features/finance/types';
import { planFundingProfileJson } from '@/features/plans/funding-profile';
import { resolveBusinessProfile } from '@/features/business-profile/resolve';
import { planWriteSchema } from '@/features/plans/schema';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';
import { guardMutationRequest } from '@/lib/request-security';
import { consumeRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const plans = await getPrisma().plan.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        revision: true,
        inputSchemaVersion: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { results: true } },
      },
    });
    return NextResponse.json({ plans });
  } catch (error) {
    return internalError(error);
  }
}

export async function POST(request: Request) {
  try {
    const blocked = guardMutationRequest(request, { requireJson: true });
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const limit = consumeRateLimit(`plan-create:${user.id}`, { max: 30, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const parsed = planWriteSchema.safeParse(await request.json());
    if (!parsed.success) return invalidZod(parsed.error);
    const prisma = getPrisma();
    const resolvedBusiness =
      parsed.data.businessProfile == null ? null : await resolveBusinessProfile(prisma, parsed.data.businessProfile);
    if (resolvedBusiness && resolvedBusiness.kind !== 'OK') {
      return apiError(
        409,
        'BUSINESS_PROFILE_UNAVAILABLE',
        '선택한 사업 조건을 현재 활성 데이터 릴리스에서 확인하지 못했습니다.',
      );
    }
    const plan = await prisma.plan.create({
      data: {
        userId: user.id,
        title: parsed.data.title,
        inputJson: parsed.data.input as Prisma.InputJsonValue,
        inputSchemaVersion: INPUT_SCHEMA_VERSION,
        // 프로필을 보내지 않으면 프로필 없는 계획으로 저장한다. 재무 입력과 달리
        // 계산 키·결과 스냅샷에 관여하지 않는다.
        fundingProfileJson: planFundingProfileJson(parsed.data.fundingProfile),
        businessProfileJson:
          resolvedBusiness === null ? Prisma.DbNull : (resolvedBusiness.profile as Prisma.InputJsonValue),
      },
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'INVALID_INPUT', '올바른 JSON 요청이 아닙니다.');
    return internalError(error);
  }
}
