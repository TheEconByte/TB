import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';

type Context = { params: Promise<{ planId: string; resultId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const { planId, resultId } = await context.params;
    const result = await getPrisma().planResult.findFirst({
      where: { id: resultId, planId, plan: { userId: user.id } },
    });
    if (!result) return apiError(404, 'NOT_FOUND', '저장 결과를 찾을 수 없습니다.');
    return NextResponse.json({ result });
  } catch (error) {
    return internalError(error);
  }
}
