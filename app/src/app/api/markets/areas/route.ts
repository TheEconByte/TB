import { NextResponse } from 'next/server';
import { marketAreasQuerySchema } from '@/features/market/schema';
import { listMarketAreas } from '@/features/market/read';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

// Public endpoint: returns the district list always, and areas for one district.
export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const districtCode = searchParams.get('districtCode');
    const parsed = marketAreasQuerySchema.safeParse(districtCode === null ? {} : { districtCode });
    if (!parsed.success) return invalidZod(parsed.error);
    const outcome = await listMarketAreas(getPrisma(), parsed.data.districtCode ?? null);
    switch (outcome.kind) {
      case 'OK':
        return NextResponse.json(outcome.payload);
      case 'RELEASE_UNAVAILABLE':
        return apiError(
          503,
          'RELEASE_UNAVAILABLE',
          '활성 상권 데이터 릴리스가 없습니다. 운영자가 적재를 완료해야 조회할 수 있습니다.',
        );
      case 'INVALID_DISTRICT_CODE':
        return apiError(
          400,
          'INVALID_DISTRICT_CODE',
          `자치구 코드 '${outcome.districtCode}'를 활성 릴리스에서 찾지 못했습니다.`,
        );
    }
  } catch (error) {
    return internalError(error);
  }
}
