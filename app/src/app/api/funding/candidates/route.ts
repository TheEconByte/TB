import { NextResponse } from 'next/server';
import { fundingCandidateRequestSchema, listFundingCandidates } from '@/features/funding/candidates';
import { todayInKst } from '@/features/funding/dates';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';
import { guardMutationRequest } from '@/lib/request-security';
import { consumeRateLimit, rateLimitResponse } from '@/lib/rate-limit';

// 인증된 사용자만 후보를 조회한다. 판정 기준일은 서버의 한국 시간 날짜로 고정하며
// 요청 본문의 asOfDate 같은 값을 받지 않는다(strictObject가 400으로 거부한다).
export async function POST(request: Request) {
  try {
    const blocked = guardMutationRequest(request, { requireJson: true });
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const limit = consumeRateLimit(`funding-candidates:${user.id}`, { max: 60, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, 'INVALID_INPUT', '올바른 JSON 요청이 아닙니다.');
    }
    const parsed = fundingCandidateRequestSchema.safeParse(body);
    if (!parsed.success) return invalidZod(parsed.error);

    const outcome = await listFundingCandidates(getPrisma(), parsed.data, { asOfDate: todayInKst() });
    if (outcome.kind === 'CATALOG_UNAVAILABLE') {
      return apiError(
        503,
        'CATALOG_UNAVAILABLE',
        '활성 자금 카탈로그 릴리스가 없습니다. 운영자가 검수한 카탈로그를 적재해야 후보를 조회할 수 있습니다.',
      );
    }
    return NextResponse.json(outcome.payload);
  } catch (error) {
    return internalError(error);
  }
}
