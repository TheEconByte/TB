import type { PrismaClient } from '../../generated/prisma/client.ts';
import {
  CONDITION_MODEL,
  CONDITION_PROMPT_VERSION,
  parseStoredConditions,
  type VerifiedConditions,
} from './condition-fields.ts';
import { todayInKst } from './dates.ts';
import { matchCatalog, type FundingMatchList, type FundingMatchProfile } from './matching.ts';
import { findActiveFundingCatalog } from './read.ts';
import type { FundingProduct } from './schema.ts';

// 활성 카탈로그를 사용자 입력과 맞춰 본다(ADR 0009 §4). 저장한 추출 결과만 읽고 AI를 부르지 않는다(AGENTS.md §2).

// 상품마다 지금 본문의 추출 결과. 지금 본문은 받은 시각이 아니라 ACTIVE 릴리스 상품 버전의 noticeTextChecksum이고,
// 지금 모델·프롬프트 버전의 결과만 쓴다(ADR 0009 §3 캐시 키). 결과가 없는 상품은 담지 않는다(조건은 읽지 못함).
export async function findConditionExtractions(
  prisma: PrismaClient,
  products: readonly Pick<FundingProduct, 'productKey' | 'noticeTextChecksum'>[],
): Promise<Map<string, VerifiedConditions>> {
  const wanted = new Map(
    products.flatMap((product) =>
      product.noticeTextChecksum === undefined ? [] : [[product.productKey, product.noticeTextChecksum] as const],
    ),
  );
  if (wanted.size === 0) return new Map();
  const rows = await prisma.fundingConditionExtraction.findMany({
    where: {
      productKey: { in: [...wanted.keys()] },
      textChecksum: { in: [...new Set(wanted.values())] },
      model: CONDITION_MODEL,
      promptVersion: CONDITION_PROMPT_VERSION,
    },
    select: { productKey: true, textChecksum: true, fields: true },
  });
  const found = new Map<string, VerifiedConditions>();
  for (const row of rows) {
    if (wanted.get(row.productKey) === row.textChecksum) found.set(row.productKey, parseStoredConditions(row.fields));
  }
  return found;
}

export type FundingMatchesRelease = {
  catalogKey: string;
  catalogVersion: string;
  schemaVersion: string;
  basisDate: string;
  activatedAt: string | null;
  productCount: number;
};

export type FundingMatchesResponse = FundingMatchList & { release: FundingMatchesRelease };

// API 응답. 맞춰 본 입력을 함께 돌려준다(계획 조회면 서버가 정한 자치구까지 들어 있다).
export type FundingMatchesWithProfile = FundingMatchesResponse & { profile: FundingMatchProfile };

export type FundingMatchesOutcome = { kind: 'OK'; payload: FundingMatchesResponse } | { kind: 'CATALOG_UNAVAILABLE' };

// 활성 카탈로그가 없으면 빈 결과가 아니라 CATALOG_UNAVAILABLE이다(AGENTS.md §3의 2번).
export async function listFundingMatches(
  prisma: PrismaClient,
  profile: FundingMatchProfile,
  options: { asOfDate?: string } = {},
): Promise<FundingMatchesOutcome> {
  const active = await findActiveFundingCatalog(prisma);
  if (!active) return { kind: 'CATALOG_UNAVAILABLE' };
  // 기준일은 호출자가 정한다. 웹 요청은 서버의 한국 시간 날짜를 쓰고, 테스트는 고정 날짜를 넘긴다.
  const asOfDate = options.asOfDate ?? todayInKst();
  const extractions = await findConditionExtractions(prisma, active.catalog.products);
  const list = matchCatalog(active.catalog, extractions, profile, { asOfDate });
  return {
    kind: 'OK',
    payload: {
      ...list,
      release: {
        catalogKey: active.catalogKey,
        catalogVersion: active.catalogVersion,
        schemaVersion: active.schemaVersion,
        basisDate: active.basisDate,
        activatedAt: active.activatedAt,
        productCount: active.productCount,
      },
    },
  };
}
