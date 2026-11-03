import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { canonicalJson } from './canonical.ts';
import { loadFundingCatalog, readFundingCatalogFile, type FundingLoadReport } from './loader.ts';
import type { NoticeDownload, NoticeExtract, NoticePlan } from './notice-body.ts';
import {
  CONDITION_MODEL,
  CONDITION_PROMPT_VERSION,
  extractNoticeConditions,
  prismaConditionExtractionStore,
  type ConditionExtractionReport,
  type ConditionExtractor,
  type ConditionTarget,
} from './notice-extraction.ts';
import { prismaNoticeTextStore, resolveNoticeText, type NoticeTextOutcome } from './notice-sync.ts';
import { extractNoticeText } from './notice-text.ts';
import { findActiveFundingCatalog } from './read.ts';
import {
  fundingProductSchema,
  sourceRefKey,
  type FundingCatalog,
  type FundingProduct,
  type FundingSourceRef,
  type FundingSourceSync,
} from './schema.ts';
import { AUTO_REVIEWER, FUNDING_CATALOG_SCHEMA_VERSION, isAutoReviewer, type FundingSource } from './types.ts';
import { FundingCatalogError, validateFundingCatalog } from './validation.ts';

// 출처별 수집기가 만든 상품. 상품 버전과 검수자는 동기화가 정한다(ADR 0006 2절).
// notice는 공고 본문을 모을 계획이다. 동기화가 본문을 정해 noticeTextChecksum으로 바꾼다(ADR 0009 §2).
export type CollectedFundingProduct = Omit<
  FundingProduct,
  'version' | 'reviewer' | 'sourceRef' | 'noticeTextChecksum'
> & {
  sourceRef: FundingSourceRef;
  notice?: NoticePlan;
};

export type FundingSourceCollection = {
  products: CollectedFundingProduct[];
  // 출처에서 받은 공고·상품 수. 직전 성공 대비 급감 판정에 쓴다.
  fetchedCount: number;
  // 이번 수집에서 받은 응답 전체의 SHA-256.
  responseChecksum: string;
};

export type FundingSourceAdapter = {
  source: FundingSource;
  collect(context: { asOfDate: string; log: (message: string) => void }): Promise<FundingSourceCollection>;
  // 공고 본문 계획의 파일을 받는다. 파일이 있는 계획을 만드는 수집기만 둔다.
  downloadNoticeFile?: NoticeDownload;
};

export type FundingSyncOptions = {
  prisma: PrismaClient;
  // 사람이 관리하는 카탈로그(app/catalog/funding/catalog.json).
  catalogPath: string;
  adapters: readonly FundingSourceAdapter[];
  // 판정 기준일(한국 시간). 운영 명령은 서버의 한국 시간 날짜를 넘긴다.
  asOfDate: string;
  // 합친 카탈로그 파일을 쓰는 폴더. 적재한 릴리스의 원본으로 남는다.
  outputDir: string;
  // true면 합친 카탈로그를 쓰고 검증만 하며 적재하지 않는다.
  dryRun?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
  // 첨부를 텍스트로 바꾸는 함수. 테스트에서 바꿔 끼운다.
  noticeExtract?: NoticeExtract;
  // 공고 본문에서 조건을 읽는 AI. null이거나 없으면 부르지 않는다(ANTHROPIC_API_KEY 없음).
  conditionExtractor?: ConditionExtractor | null;
};

export type FundingSourceSyncReport = FundingSourceSync & {
  // 이번 릴리스에 들어간 이 출처의 자동 상품 수.
  productCount: number;
  // 실패해서 직전 ACTIVE 릴리스의 상품을 그대로 가져왔는지.
  carriedOver: boolean;
  // 직전 ACTIVE 릴리스에 없던 공고로 만든 상품. 운영자가 새 공고·변경공고를 살펴보는 데 쓴다.
  addedProducts: Array<{ productKey: string; name: string }>;
  // 공고 본문을 정한 결과별 상품 수. 출처가 실패했으면 모두 0이다.
  noticeTexts: Record<NoticeTextOutcome['outcome'], number>;
};

function emptyNoticeCounts(): Record<NoticeTextOutcome['outcome'], number> {
  return { REUSED: 0, STORED: 0, NO_TEXT: 0, INCOMPLETE: 0 };
}

export type FundingSyncReport = {
  catalogFile: string;
  catalogKey: string;
  catalogVersion: string;
  sources: FundingSourceSyncReport[];
  manualProductCount: number;
  automatedProductCount: number;
  // 사람이 기록한 상품이 같은 공고를 가리켜 빠진 자동 상품의 출처 식별자.
  overriddenByManual: string[];
  // 적재 결과. dryRun이면 null이다.
  load: FundingLoadReport | null;
  // 공고 본문의 조건 추출 결과(ADR 0009 §3). dryRun이면 부르지 않아 null이다.
  conditions: ConditionExtractionReport | null;
};

class SourceSyncFailure extends Error {}

// 날짜처럼 동기화마다 바뀌는 값을 뺀 상품 내용. 이 값이 같으면 이미 적재된 불변 상품 버전을 재사용해
// 상품 버전이 날마다 늘지 않게 한다.
export function productContentFingerprint(product: Omit<FundingProduct, 'version'> | FundingProduct): string {
  const content: Record<string, unknown> = { ...product };
  delete content.version;
  delete content.observedAt;
  delete content.reviewedAt;
  delete content.nextReviewAt;
  content.evidence = product.evidence.map((entry) => {
    const stable: Record<string, unknown> = { ...entry };
    delete stable.observedAt;
    delete stable.checksum;
    return stable;
  });
  return canonicalJson(content);
}

// 가장 높은 MAJOR.MINOR.PATCH의 PATCH를 하나 올린다. 버전이 없으면 1.0.0이다.
export function nextPatchVersion(versions: readonly string[]): string {
  const parsed = versions
    .map((version) => version.split('.').map((part) => Number(part)))
    .filter((parts) => parts.length === 3 && parts.every((part) => Number.isInteger(part) && part >= 0));
  if (parsed.length === 0) return '1.0.0';
  parsed.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
  const [major, minor, patch] = parsed[parsed.length - 1];
  return `${major}.${minor}.${patch + 1}`;
}

async function assignVersion(prisma: PrismaClient, product: Omit<FundingProduct, 'version'>): Promise<FundingProduct> {
  const stored = await prisma.fundingProductVersion.findMany({
    where: { productKey: product.productKey },
    select: { version: true, productJson: true },
  });
  const fingerprint = productContentFingerprint(product);
  for (const row of stored) {
    const parsed = fundingProductSchema.safeParse(row.productJson);
    if (parsed.success && productContentFingerprint(parsed.data) === fingerprint) return parsed.data;
  }
  return fundingProductSchema.parse({ ...product, version: nextPatchVersion(stored.map((row) => row.version)) });
}

// 같은 날 여러 번 동기화해도 catalogKey + catalogVersion이 겹치지 않게 날짜 뒤 번호를 올린다.
// 사람이 관리하는 카탈로그의 버전도 피해서, 그 파일을 funding:load로 적재할 때 버전이 충돌하지 않게 한다.
async function nextCatalogVersion(prisma: PrismaClient, manual: FundingCatalog, asOfDate: string): Promise<string> {
  const releases = await prisma.fundingCatalogRelease.findMany({
    where: { catalogKey: manual.catalogKey, catalogVersion: { startsWith: `${asOfDate}.` } },
    select: { catalogVersion: true },
  });
  const used = [...releases.map((release) => release.catalogVersion), manual.catalogVersion]
    .filter((version) => version.startsWith(`${asOfDate}.`))
    .map((version) => Number(version.slice(asOfDate.length + 1)))
    .filter((value) => Number.isInteger(value));
  return `${asOfDate}.${Math.max(0, ...used) + 1}`;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

async function collectSource(
  adapter: FundingSourceAdapter,
  context: {
    prisma: PrismaClient;
    manual: FundingCatalog;
    previousSync: FundingSourceSync | null;
    // 직전 ACTIVE 릴리스에 있던 이 출처의 상품. 공고 본문을 다시 쓸 수 있는지 보는 데 쓴다.
    previousProducts: readonly FundingProduct[];
    asOfDate: string;
    dryRun: boolean;
    now: () => Date;
    extract: NoticeExtract;
    log: (message: string) => void;
  },
): Promise<{
  products: FundingProduct[];
  fetchedCount: number;
  responseChecksum: string;
  noticeTexts: Record<NoticeTextOutcome['outcome'], number>;
}> {
  const collection = await adapter.collect({ asOfDate: context.asOfDate, log: context.log });
  if (collection.fetchedCount === 0 || collection.products.length === 0) {
    throw new SourceSyncFailure(
      '출처에서 받은 공고가 없습니다. 빈 응답은 "공고 없음"으로 해석하지 않고 실패로 기록합니다.',
    );
  }
  const previousCount = context.previousSync?.fetchedCount ?? null;
  if (previousCount !== null && collection.fetchedCount * 2 < previousCount) {
    throw new SourceSyncFailure(
      `받은 공고 수 ${collection.fetchedCount}건이 직전 성공 ${previousCount}건의 절반 미만입니다. 급감은 실패로 기록합니다.`,
    );
  }
  const manualKeys = new Set(context.manual.products.map((product) => product.productKey));
  const refs = new Set<string>();
  for (const product of collection.products) {
    if (product.sourceRef.source !== adapter.source) {
      throw new SourceSyncFailure(
        `${adapter.source} 수집기가 다른 출처(${product.sourceRef.source})의 상품을 만들었습니다.`,
      );
    }
    if (manualKeys.has(product.productKey)) {
      throw new SourceSyncFailure(`자동 상품 키 ${product.productKey}가 사람이 기록한 상품 키와 겹칩니다.`);
    }
    const refKey = sourceRefKey(product.sourceRef);
    if (refs.has(refKey)) throw new SourceSyncFailure(`같은 공고(${refKey})가 두 번 수집되었습니다.`);
    refs.add(refKey);
  }

  // 수집한 상품만으로 카탈로그 검증을 먼저 돌린다. 파서가 필수 항목을 못 찾은 상품이 있으면
  // 그 출처만 실패로 기록하고, 사람이 관리하는 상품과 다른 출처는 그대로 적재한다.
  // 공고 파일을 받기 전에 돌려, 실패할 출처를 위해 수십 분씩 파일을 받지 않게 한다. 버전과 본문 checksum은
  // 규칙 검사에 쓰이지 않아 임시 버전으로 검사한다.
  const validation = validateFundingCatalog(
    {
      catalogKey: context.manual.catalogKey,
      schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
      catalogVersion: `${context.asOfDate}.1`,
      basisDate: context.asOfDate,
      reviewer: context.manual.reviewer,
      notes: [],
      automation: context.manual.automation,
      // 스키마가 모르는 항목(본문 계획 notice)은 parse가 뺀다.
      products: collection.products.map((product) =>
        fundingProductSchema.parse({ ...product, reviewer: AUTO_REVIEWER, version: '0.0.0' }),
      ),
    },
    { asOfDate: context.asOfDate },
  );
  if (!validation.ok) {
    const issues = validation.issues
      .slice(0, 5)
      .map((issue) => `[${issue.code}] ${issue.source}: ${issue.detail}`)
      .join(' / ');
    throw new SourceSyncFailure(`수집한 상품이 카탈로그 검증을 통과하지 못했습니다: ${issues}`);
  }

  // 공고 본문을 정한다. 본문이 바뀌면 상품 내용(noticeTextChecksum)이 바뀌어 새 상품 버전이 된다.
  const noticeTexts = emptyNoticeCounts();
  const incompleteReasons: string[] = [];
  const store = prismaNoticeTextStore(context.prisma, { dryRun: context.dryRun });
  const previousChecksums = new Map(
    context.previousProducts.map((product) => [product.productKey, product.noticeTextChecksum ?? null]),
  );
  const products: FundingProduct[] = [];
  for (const collected of collection.products) {
    const { notice, ...product } = collected;
    let noticeTextChecksum: string | null = null;
    if (notice !== undefined) {
      const download = adapter.downloadNoticeFile;
      if (notice.files.length > 0 && download === undefined) {
        throw new SourceSyncFailure(
          `${adapter.source} 수집기가 받을 파일이 있는 본문 계획을 만들었지만 파일을 받는 방법이 없습니다.`,
        );
      }
      const resolved = await resolveNoticeText(
        {
          productKey: product.productKey,
          plan: notice,
          previousChecksum: previousChecksums.get(product.productKey) ?? null,
        },
        {
          store,
          download:
            download ?? (async () => ({ ok: false, transient: false, message: '파일을 받는 방법이 없습니다.' })),
          extract: context.extract,
          now: context.now,
        },
      );
      noticeTexts[resolved.outcome] += 1;
      if (resolved.outcome === 'INCOMPLETE') incompleteReasons.push(`${product.productKey}: ${resolved.reason}`);
      noticeTextChecksum = resolved.textChecksum;
    }
    products.push(
      await assignVersion(context.prisma, {
        ...product,
        reviewer: AUTO_REVIEWER,
        ...(noticeTextChecksum === null ? {} : { noticeTextChecksum }),
      }),
    );
  }
  context.log(
    `출처 ${adapter.source} 공고 본문: 그대로 ${noticeTexts.REUSED}건, 새로 읽음 ${noticeTexts.STORED}건, 읽을 문서 없음 ${noticeTexts.NO_TEXT}건, 파일을 다 받지 못함 ${noticeTexts.INCOMPLETE}건${context.dryRun ? '(dry run이라 저장하지 않음)' : ''}.`,
  );
  for (const reason of incompleteReasons.slice(0, 5)) context.log(`  - ${reason}`);
  return {
    products,
    fetchedCount: collection.fetchedCount,
    responseChecksum: collection.responseChecksum,
    noticeTexts,
  };
}

// 출처별로 공고를 모아 사람이 관리하는 카탈로그와 합치고, 기존 적재기로 새 릴리스를 적재한다(ADR 0006).
// 한 출처가 실패하면 그 출처의 상품은 직전 ACTIVE 릴리스의 것을 그대로 가져오고 마지막 성공일도
// 그대로 둔다. 그 상품은 마지막 성공일에서 SOURCE_FRESHNESS_DAYS가 지나면 판정에서 현재 후보가 아니다.
export async function runFundingSync(options: FundingSyncOptions): Promise<FundingSyncReport> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const { prisma, asOfDate } = options;

  const manual = readFundingCatalogFile(options.catalogPath, asOfDate).catalog;
  const automatedInManual = manual.products.filter((product) => isAutoReviewer(product.reviewer));
  if (automatedInManual.length > 0) {
    throw new FundingCatalogError(
      'MANUAL_CATALOG_HAS_AUTOMATED_PRODUCT',
      `사람이 관리하는 카탈로그에 자동 검수자 상품이 있습니다: ${automatedInManual.map((product) => product.productKey).join(', ')}. 자동 상품은 funding:sync만 만듭니다.`,
    );
  }
  const seenSources = new Set<FundingSource>();
  for (const adapter of options.adapters) {
    if (seenSources.has(adapter.source)) {
      throw new FundingCatalogError(
        'DUPLICATE_SOURCE_ADAPTER',
        `출처 ${adapter.source}의 수집기가 두 번 등록되었습니다.`,
      );
    }
    seenSources.add(adapter.source);
  }

  const previous = await findActiveFundingCatalog(prisma);
  const sources: FundingSourceSyncReport[] = [];
  const automatedProducts: FundingProduct[] = [];
  for (const adapter of options.adapters) {
    const previousSync = previous?.automation.sourceSyncs.find((entry) => entry.source === adapter.source) ?? null;
    const attemptedAt = now().toISOString();
    const previousProducts = (previous?.catalog.products ?? []).filter(
      (product) => isAutoReviewer(product.reviewer) && product.sourceRef?.source === adapter.source,
    );
    try {
      const collected = await collectSource(adapter, {
        prisma,
        manual,
        previousSync,
        previousProducts,
        asOfDate,
        dryRun: options.dryRun ?? false,
        now,
        extract: options.noticeExtract ?? extractNoticeText,
        log,
      });
      automatedProducts.push(...collected.products);
      const previousRefs = new Set(
        previousProducts.flatMap((product) =>
          product.sourceRef === undefined ? [] : [sourceRefKey(product.sourceRef)],
        ),
      );
      sources.push({
        source: adapter.source,
        status: 'SUCCEEDED',
        attemptedAt,
        lastSucceededOn: asOfDate,
        fetchedCount: collected.fetchedCount,
        responseChecksum: collected.responseChecksum,
        failureReason: null,
        productCount: collected.products.length,
        carriedOver: false,
        addedProducts: collected.products
          .filter((product) => product.sourceRef !== undefined && !previousRefs.has(sourceRefKey(product.sourceRef)))
          .map((product) => ({ productKey: product.productKey, name: product.name })),
        noticeTexts: collected.noticeTexts,
      });
      log(
        `출처 ${adapter.source}: 공고 ${collected.fetchedCount}건을 받아 상품 ${collected.products.length}건을 만들었습니다.`,
      );
    } catch (error) {
      automatedProducts.push(...previousProducts);
      sources.push({
        source: adapter.source,
        status: 'FAILED',
        attemptedAt,
        lastSucceededOn: previousSync?.lastSucceededOn ?? null,
        fetchedCount: previousSync?.fetchedCount ?? null,
        responseChecksum: previousSync?.responseChecksum ?? null,
        failureReason: describeError(error),
        productCount: previousProducts.length,
        carriedOver: true,
        addedProducts: [],
        noticeTexts: emptyNoticeCounts(),
      });
      log(
        `출처 ${adapter.source} 동기화 실패: ${describeError(error)} 직전 ACTIVE 릴리스의 상품 ${previousProducts.length}건을 그대로 둡니다.`,
      );
    }
  }

  // 사람이 기록한 상품이 같은 공고를 가리키면 사람 기록이 우선한다.
  const manualRefs = new Set(
    manual.products.flatMap((product) => (product.sourceRef === undefined ? [] : [sourceRefKey(product.sourceRef)])),
  );
  const overriddenByManual: string[] = [];
  const keptAutomated = automatedProducts
    .filter((product) => {
      const refKey = product.sourceRef === undefined ? null : sourceRefKey(product.sourceRef);
      if (refKey !== null && manualRefs.has(refKey)) {
        overriddenByManual.push(refKey);
        return false;
      }
      return true;
    })
    .sort((left, right) => (left.productKey < right.productKey ? -1 : left.productKey > right.productKey ? 1 : 0));

  const catalogVersion = await nextCatalogVersion(prisma, manual, asOfDate);
  const composed: FundingCatalog = {
    catalogKey: manual.catalogKey,
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    basisDate: asOfDate,
    reviewer: manual.reviewer,
    notes: [
      ...manual.notes,
      `funding:sync가 ${asOfDate}에 사람이 관리하는 카탈로그 ${manual.catalogVersion}과 자동 상품 ${keptAutomated.length}건을 합쳤습니다.`,
    ],
    automation: {
      ...manual.automation,
      sourceSyncs: sources.map((entry) => ({
        source: entry.source,
        status: entry.status,
        attemptedAt: entry.attemptedAt,
        lastSucceededOn: entry.lastSucceededOn,
        fetchedCount: entry.fetchedCount,
        responseChecksum: entry.responseChecksum,
        failureReason: entry.failureReason,
      })),
    },
    products: [...manual.products, ...keptAutomated],
  };

  mkdirSync(options.outputDir, { recursive: true });
  const catalogFile = join(options.outputDir, `${composed.catalogKey}@${catalogVersion}.json`);
  writeFileSync(catalogFile, `${JSON.stringify(composed, null, 2)}\n`, 'utf8');
  log(`합친 카탈로그를 썼습니다: ${catalogFile}`);

  let load: FundingLoadReport | null = null;
  if (options.dryRun) {
    // 적재와 같은 검사만 돌린다. 통과하지 못하면 FundingCatalogError를 던진다.
    readFundingCatalogFile(catalogFile, asOfDate);
    log('dry run: 검증만 하고 적재하지 않았습니다.');
  } else {
    load = await loadFundingCatalog({ catalogPath: catalogFile, prisma, asOfDate, log });
  }

  // 적재한 카탈로그의 본문마다 조건을 읽는다. 직전 동기화에서 실패한 본문도 여기서 다시 부른다.
  // 실패는 출처 동기화 실패가 아니다. dry run은 비용이 드는 AI를 부르지 않는다.
  let conditions: ConditionExtractionReport | null = null;
  if (!options.dryRun) {
    const targets = new Map<string, ConditionTarget>();
    for (const product of composed.products) {
      if (product.noticeTextChecksum === undefined) continue;
      targets.set(`${product.productKey}:${product.noticeTextChecksum}`, {
        productKey: product.productKey,
        name: product.name,
        textChecksum: product.noticeTextChecksum,
      });
    }
    conditions = await extractNoticeConditions([...targets.values()], {
      store: prismaConditionExtractionStore(prisma),
      extractor: options.conditionExtractor ?? null,
      now,
    });
    const counts = conditions.counts;
    log(
      `공고 조건 추출(${CONDITION_MODEL}, ${CONDITION_PROMPT_VERSION}): 이미 읽음 ${counts.CACHED}건, 새로 읽음 ${counts.EXTRACTED}건, 실패 ${counts.FAILED}건, 키 없음 ${counts.NOT_CONFIGURED}건, 너무 김 ${counts.TOO_LONG}건, 본문 없음 ${counts.NO_TEXT}건 · 입력 ${conditions.inputTokens}토큰, 출력 ${conditions.outputTokens}토큰`,
    );
    for (const failure of conditions.failures.slice(0, 5)) log(`  - ${failure}`);
  }

  return {
    catalogFile,
    catalogKey: composed.catalogKey,
    catalogVersion,
    sources,
    manualProductCount: manual.products.length,
    automatedProductCount: keptAutomated.length,
    overriddenByManual,
    load,
    conditions,
  };
}
