import { NextResponse } from 'next/server';
import { marketSummaryQuerySchema } from '@/features/market/schema';
import { getMarketSummary } from '@/features/market/read';
import type { MarketReport } from '@/features/market/types';
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
    if (outcome.kind !== 'OK') {
      switch (outcome.kind) {
        case 'RELEASE_UNAVAILABLE':
          return apiError(503, 'RELEASE_UNAVAILABLE', '활성 상권 데이터 릴리스가 없습니다.');
        case 'INVALID_AREA_CODE':
          return apiError(400, 'INVALID_AREA_CODE', `상권 코드 '${outcome.areaCode}' 형식이 올바르지 않습니다.`);
        case 'AREA_NOT_FOUND':
          return apiError(404, 'AREA_NOT_FOUND', `활성 릴리스에 상권 코드 '${outcome.areaCode}'가 없습니다.`);
        case 'AMBIGUOUS_AREA_CODE':
          return apiError(400, 'AMBIGUOUS_AREA_CODE', `상권 구분을 지정해 주세요: ${outcome.areaTypes.join(', ')}`);
        case 'INVALID_INDUSTRY_CODE':
          return apiError(400, 'INVALID_INDUSTRY_CODE', `업종 코드 '${outcome.industryCode}'를 찾지 못했습니다.`);
        case 'UNSUPPORTED_INDUSTRY':
          return apiError(400, 'UNSUPPORTED_INDUSTRY', `현재 지원하지 않는 업종 코드입니다: ${outcome.industryCode}`);
      }
    }
    const latestQuarter = outcome.payload.quarters.at(-1)?.quarter ?? null;
    const report: MarketReport = {
      ...outcome.payload,
      observedScope: {
        kind: 'BROAD_INDUSTRY',
        code: outcome.payload.industry.code,
        label: outcome.payload.industry.displayName,
        statement: `${outcome.payload.industry.displayName} 전체 기준 서울시 상권분석서비스(추정매출-상권) 관측값입니다. 세부 업종 매출이나 개인 예상매출이 아닙니다.`,
      },
      competitionScope: null,
      sourceRelease: outcome.payload.release.releaseKey,
      asOf: latestQuarter,
      nullReason: outcome.payload.dataStatus === 'NOT_PROVIDED' ? outcome.payload.dataStatusMessage : null,
    };
    return NextResponse.json(report);
  } catch (error) {
    return internalError(error);
  }
}
