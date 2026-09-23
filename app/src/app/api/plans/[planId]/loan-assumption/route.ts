import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { financeInputSchema } from '@/features/finance/schema';
import type { FinanceInput } from '@/features/finance/types';
import { fundingCandidateRequestSchema } from '@/features/funding/candidates';
import { todayInKst } from '@/features/funding/dates';
import { assessProductRepayment, evaluateProduct } from '@/features/funding/eligibility';
import { findActiveFundingCatalog } from '@/features/funding/read';
import { loanAssumptionFromProduct } from '@/features/plans/loan-assumption';
import { apiError, internalError, invalidZod } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';
import { currentUser } from '@/lib/session';
import { guardMutationRequest } from '@/lib/request-security';
import { consumeRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ planId: string }> };

// 사용자가 명시적으로 누른 적용만 처리한다. 조회·판정·저장 시점에는 상품 확정 조건을
// 대출 가정으로 자동 대입하지 않는다. 적용 대상 상품은 서버가 활성 카탈로그에서 다시
// 읽어 확정 조건을 확인하므로 클라이언트가 값을 만들거나 출처를 주장할 수 없다.
const requestSchema = z.strictObject({
  productKey: z.string().min(1),
  version: z.string().min(1),
  revision: z.number().int().positive(),
});

export async function POST(request: Request, context: Context) {
  try {
    const blocked = guardMutationRequest(request, { requireJson: true });
    if (blocked) return blocked;
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const limit = consumeRateLimit(`loan-assumption:${user.id}`, { max: 30, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, 'INVALID_INPUT', '올바른 JSON 요청이 아닙니다.');
    }
    const parsedRequest = requestSchema.safeParse(body);
    if (!parsedRequest.success) return invalidZod(parsedRequest.error);

    const { planId } = await context.params;
    const prisma = getPrisma();
    const plan = await prisma.plan.findFirst({
      where: { id: planId, userId: user.id },
      select: { id: true, revision: true, inputJson: true, fundingProfileJson: true },
    });
    if (!plan) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');

    const active = await findActiveFundingCatalog(prisma);
    if (!active) {
      return apiError(
        503,
        'CATALOG_UNAVAILABLE',
        '활성 자금 카탈로그 릴리스가 없습니다. 운영자가 검수한 카탈로그를 적재해야 상품 조건을 적용할 수 있습니다.',
      );
    }
    const product = active.catalog.products.find(
      (entry) => entry.productKey === parsedRequest.data.productKey && entry.version === parsedRequest.data.version,
    );
    if (!product) {
      return apiError(
        400,
        'INVALID_INPUT',
        '활성 카탈로그에서 해당 상품 버전을 찾을 수 없습니다. 후보를 다시 조회해 주세요.',
      );
    }

    const parsedProfile = fundingCandidateRequestSchema.safeParse(plan.fundingProfileJson);
    if (!parsedProfile.success) {
      return apiError(
        400,
        'INVALID_INPUT',
        '저장된 자금 조건이 없거나 현재 스키마와 맞지 않습니다. 자금 조건을 저장한 뒤 다시 조회해 주세요.',
      );
    }
    const evaluation = evaluateProduct(product, parsedProfile.data, { asOfDate: todayInKst() });
    if (evaluation.candidateStatus !== 'CURRENT_CANDIDATE') {
      return apiError(
        400,
        'INVALID_INPUT',
        `이 상품은 현재 계획의 검토 후보가 아니어서 적용할 수 없습니다. 상태: ${evaluation.candidateStatus}. ${evaluation.candidateReason}`,
      );
    }

    // 원금은 공개 한도가 아니라 사용자가 초안에 명시해 저장한 신규 대출금이다.
    // 상품 한도는 최대값 검증에만 쓰고 신청·승인 금액으로 자동 확정하지 않는다.
    const parsedInput = financeInputSchema.safeParse(plan.inputJson);
    if (!parsedInput.success) {
      return apiError(
        400,
        'INVALID_INPUT',
        '저장된 초안 입력이 현재 스키마와 맞지 않습니다. 재무 입력을 다시 저장해 주세요.',
        parsedInput.error.flatten(),
      );
    }
    const requestedPrincipal = parsedInput.data.newLoan.principal;
    if (requestedPrincipal === null || requestedPrincipal === '0') {
      return apiError(
        400,
        'INVALID_INPUT',
        '신규 대출금에 시뮬레이션할 금액을 1원 이상 입력하고 초안을 저장해 주세요.',
      );
    }
    const repayment = assessProductRepayment(product);
    if (repayment.publicLimitKrw !== null && BigInt(requestedPrincipal) > BigInt(repayment.publicLimitKrw)) {
      return apiError(
        400,
        'INVALID_INPUT',
        `저장된 신규 대출금이 상품 공개 한도 ${repayment.publicLimitKrw}원을 초과합니다.`,
      );
    }

    const loanAssumption = loanAssumptionFromProduct(
      product,
      { catalogKey: active.catalogKey, catalogVersion: active.catalogVersion },
      new Date().toISOString(),
      requestedPrincipal,
    );
    if (loanAssumption === null) {
      const repayment = assessProductRepayment(product);
      const reasons = repayment.reasons.length > 0 ? repayment.reasons.join(' / ') : repayment.note;
      return apiError(
        400,
        'INVALID_INPUT',
        `이 상품은 상환 계산 대상이 아니어서 대출 가정으로 적용할 수 없습니다. ${reasons}`,
      );
    }

    const nextInput: FinanceInput = { ...(parsedInput.data as FinanceInput), newLoan: loanAssumption.newLoan };

    const changed = await prisma.plan.updateMany({
      where: { id: planId, userId: user.id, revision: parsedRequest.data.revision },
      data: {
        inputJson: nextInput as Prisma.InputJsonValue,
        loanAssumptionJson: loanAssumption as unknown as Prisma.InputJsonValue,
        revision: { increment: 1 },
      },
    });
    if (changed.count === 0) {
      const exists = await prisma.plan.findFirst({
        where: { id: planId, userId: user.id },
        select: { revision: true },
      });
      if (!exists) return apiError(404, 'NOT_FOUND', '계획을 찾을 수 없습니다.');
      return apiError(409, 'REVISION_CONFLICT', '다른 화면에서 계획이 먼저 수정되었습니다.', {
        currentRevision: exists.revision,
      });
    }
    const updated = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    return NextResponse.json({ plan: updated, loanAssumption });
  } catch (error) {
    return internalError(error);
  }
}
