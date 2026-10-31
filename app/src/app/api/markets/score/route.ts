import { NextResponse } from 'next/server';
import { getMarketScore, marketScoreQuerySchema } from '@/features/market/score/api';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

// 로그인 없이 공개한다. 활성 점수 릴리스만 읽고, 상태(정상·표본 부족·미지원 업종·데이터 없음)는 200으로 구분한다.
export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsed = marketScoreQuerySchema.safeParse({
      areaCode: searchParams.get('areaCode') ?? '',
      industryCode: searchParams.get('industryCode') ?? '',
      ...(searchParams.get('areaType') === null ? {} : { areaType: searchParams.get('areaType') }),
    });
    if (!parsed.success) return invalidZod(parsed.error);
    const outcome = await getMarketScore(getPrisma(), parsed.data);
    switch (outcome.kind) {
      case 'OK':
        return NextResponse.json(outcome.payload);
      case 'SCORE_UNAVAILABLE':
        return apiError(503, 'SCORE_UNAVAILABLE', '활성 상권 생존점수 릴리스가 없습니다.');
      case 'INVALID_AREA_CODE':
        return apiError(400, 'INVALID_AREA_CODE', `상권 코드 '${outcome.areaCode}' 형식이 올바르지 않습니다.`);
      case 'INVALID_INDUSTRY_CODE':
        return apiError(400, 'INVALID_INDUSTRY_CODE', `업종 코드 '${outcome.industryCode}' 형식이 올바르지 않습니다.`);
      case 'AREA_NOT_FOUND':
        return apiError(404, 'AREA_NOT_FOUND', `점수 릴리스에 상권 코드 '${outcome.areaCode}'가 없습니다.`);
      case 'AMBIGUOUS_AREA_CODE':
        return apiError(400, 'AMBIGUOUS_AREA_CODE', `상권 구분을 지정해 주세요: ${outcome.areaTypes.join(', ')}`);
    }
  } catch (error) {
    return internalError(error);
  }
}
