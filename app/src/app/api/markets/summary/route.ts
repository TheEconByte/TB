import { NextResponse } from 'next/server';
import { marketSummaryQuerySchema } from '@/features/market/schema';
import { getMarketSummary } from '@/features/market/read';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsed = marketSummaryQuerySchema.safeParse({
      areaCode: searchParams.get('areaCode') ?? '',
      industryCode: searchParams.get('industryCode') ?? '',
      ...(searchParams.get('areaType') === null ? {} : { areaType: searchParams.get('areaType') }),
    });
    if (!parsed.success) return invalidZod(parsed.error);
    const outcome = await getMarketSummary(getPrisma(), parsed.data);
    switch (outcome.kind) {
      case 'OK':
        return NextResponse.json(outcome.payload);
      case 'RELEASE_UNAVAILABLE':
        return apiError(
          503,
          'RELEASE_UNAVAILABLE',
          '활성 상권 데이터 릴리스가 없습니다. 운영자가 적재를 완료해야 조회할 수 있습니다.',
        );
      case 'INVALID_AREA_CODE':
        return apiError(400, 'INVALID_AREA_CODE', `상권 코드 '${outcome.areaCode}' 형식이 올바르지 않습니다.`);
      case 'AREA_NOT_FOUND':
        return apiError(404, 'AREA_NOT_FOUND', `활성 릴리스에 상권 코드 '${outcome.areaCode}'가 없습니다.`);
      case 'AMBIGUOUS_AREA_CODE':
        return apiError(
          400,
          'AMBIGUOUS_AREA_CODE',
          `상권 코드 '${outcome.areaCode}'가 상권 구분 ${outcome.areaTypes.join(', ')}에 함께 있습니다. areaType을 지정해 주세요.`,
        );
      case 'INVALID_INDUSTRY_CODE':
        return apiError(
          400,
          'INVALID_INDUSTRY_CODE',
          `업종 코드 '${outcome.industryCode}'를 원천 분류에서 찾지 못했습니다.`,
        );
      case 'UNSUPPORTED_INDUSTRY':
        return apiError(
          400,
          'UNSUPPORTED_INDUSTRY',
          `업종 코드 '${outcome.industryCode}'는 현재 지원하지 않습니다. GET /api/industries의 코드만 조회할 수 있습니다.`,
        );
    }
  } catch (error) {
    return internalError(error);
  }
}
