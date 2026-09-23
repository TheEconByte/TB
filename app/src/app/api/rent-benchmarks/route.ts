import { NextResponse } from 'next/server';
import { getRentBenchmarks } from '@/features/rent-benchmark/read';
import { rentBenchmarkQuerySchema } from '@/features/rent-benchmark/schema';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsed = rentBenchmarkQuerySchema.safeParse({
      buildingType: searchParams.get('buildingType') ?? '',
      districtCode: searchParams.get('districtCode') || null,
    });
    if (!parsed.success) return invalidZod(parsed.error);
    const outcome = await getRentBenchmarks(getPrisma(), parsed.data);
    if (outcome.kind === 'OK') return NextResponse.json(outcome.payload);
    // 적재 전에는 샘플 숫자나 0으로 성공 응답을 만들지 않는다.
    return apiError(
      503,
      'DATASET_UNAVAILABLE',
      '활성 한국부동산원 임대료 스냅샷이 없습니다. 운영자가 적재해야 합니다.',
      {
        nullReason: 'RELEASE_NOT_LOADED',
      },
    );
  } catch (error) {
    return internalError(error);
  }
}
