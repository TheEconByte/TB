import { NextResponse } from 'next/server';
import { getFranchises } from '@/features/franchise/read';
import { franchiseQuerySchema } from '@/features/franchise/schema';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsed = franchiseQuerySchema.safeParse({
      industryCode: searchParams.get('industryCode') ?? '',
      query: searchParams.get('q') ?? '',
      limit: searchParams.get('limit') ?? 10,
    });
    if (!parsed.success) return invalidZod(parsed.error);
    const outcome = await getFranchises(getPrisma(), parsed.data);
    if (outcome.kind === 'OK') return NextResponse.json(outcome.payload);
    // 적재 전에는 샘플 숫자나 0으로 성공 응답을 만들지 않는다.
    return apiError(503, 'DATASET_UNAVAILABLE', '활성 공정위 가맹정보 스냅샷이 없습니다. 운영자가 적재해야 합니다.', {
      nullReason: 'RELEASE_NOT_LOADED',
    });
  } catch (error) {
    return internalError(error);
  }
}
