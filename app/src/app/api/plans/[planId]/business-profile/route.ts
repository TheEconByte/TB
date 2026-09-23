import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/prisma/client';
import { businessProfileUpdateSchema } from '@/features/business-profile/schema';
import { resolveBusinessProfile } from '@/features/business-profile/resolve';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { guardMutationRequest } from '@/lib/request-security';
import { currentUser } from '@/lib/session';

type Context = { params: Promise<{ planId: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const blocked = guardMutationRequest(request, { requireJson: true });
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const parsed = businessProfileUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return invalidZod(parsed.error);
    const prisma = getPrisma();
    const resolved =
      parsed.data.businessProfile === null ? null : await resolveBusinessProfile(prisma, parsed.data.businessProfile);
    if (resolved && resolved.kind !== 'OK') {
      if (resolved.kind === 'MARKET_RELEASE_UNAVAILABLE')
        return apiError(503, 'MARKET_RELEASE_UNAVAILABLE', '활성 서울시 상권 데이터가 없습니다.');
      if (resolved.kind === 'INDUSTRY_NOT_FOUND')
        return apiError(400, 'INDUSTRY_NOT_FOUND', '활성 서울시 릴리스에서 선택한 상위 업종을 찾지 못했습니다.');
      return apiError(
        409,
        'DETAIL_CATEGORY_UNAVAILABLE',
        '활성 소진공 스냅샷에서 상위 업종과 일치하는 세부 업종을 찾지 못했습니다.',
      );
    }
    const { planId } = await context.params;
    const changed = await prisma.plan.updateMany({
      where: { id: planId, userId: user.id, revision: parsed.data.revision },
      data: {
        businessProfileJson: resolved === null ? Prisma.DbNull : (resolved.profile as Prisma.InputJsonValue),
        revision: { increment: 1 },
      },
    });
    if (changed.count === 1) {
      const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
      return NextResponse.json({ plan });
    }
    const exists = await prisma.plan.findFirst({ where: { id: planId, userId: user.id }, select: { revision: true } });
    if (!exists) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
    return apiError(409, 'REVISION_CONFLICT', '다른 화면에서 계획이 먼저 수정되었습니다.', {
      currentRevision: exists.revision,
    });
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'INVALID_INPUT', '올바른 JSON 요청이 아닙니다.');
    return internalError(error);
  }
}
