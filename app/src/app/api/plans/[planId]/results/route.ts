import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';

type Context = { params: Promise<{ planId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const { planId } = await context.params;
    const plan = await getPrisma().plan.findFirst({ where: { id: planId, userId: user.id }, select: { id: true } });
    if (!plan) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
    const results = await getPrisma().planResult.findMany({
      where: { planId },
      orderBy: { calculatedAt: 'desc' },
      select: { id: true, inputRevision: true, inputSchemaVersion: true, calculationVersion: true, calculatedAt: true },
    });
    return NextResponse.json({ results });
  } catch (error) {
    return internalError(error);
  }
}
