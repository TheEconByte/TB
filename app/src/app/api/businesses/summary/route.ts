import { NextResponse } from 'next/server';
import { getBusinessSummary } from '@/features/business-directory/read';
import { businessSummaryQuerySchema } from '@/features/business-directory/schema';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsed = businessSummaryQuerySchema.safeParse({
      districtCode: searchParams.get('districtCode') ?? '',
      detailedIndustryCode: searchParams.get('detailedIndustryCode') ?? '',
    });
    if (!parsed.success) return invalidZod(parsed.error);
    const outcome = await getBusinessSummary(getPrisma(), parsed.data);
    if (outcome.kind === 'OK') return NextResponse.json(outcome.payload);
    if (outcome.kind === 'RELEASE_UNAVAILABLE') {
      return apiError(
        503,
        'BUSINESS_DIRECTORY_UNAVAILABLE',
        '활성 소진공 상가(상권)정보 스냅샷이 없습니다. 운영자가 적재해야 합니다.',
      );
    }
    return apiError(404, 'BUSINESS_CATEGORY_NOT_FOUND', '활성 스냅샷에서 요청한 세부 업종을 찾지 못했습니다.');
  } catch (error) {
    return internalError(error);
  }
}
