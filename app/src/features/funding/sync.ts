import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { canonicalJson } from './canonical.ts';
import { loadFundingCatalog, readFundingCatalogFile, type FundingLoadReport } from './loader.ts';
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
export type CollectedFundingProduct = Omit<FundingProduct, 'version' | 'reviewer' | 'sourceRef'> & {
  sourceRef: FundingSourceRef;
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
};

export type FundingSourceSyncReport = FundingSourceSync & {
  // 이번 릴리스에 들어간 이 출처의 자동 상품 수.
  productCount: number;
  // 실패해서 직전 ACTIVE 릴리스의 상품을 그대로 가져왔는지.
  carriedOver: boolean;
  // 직전 ACTIVE 릴리스에 없던 공고로 만든 상품. 운영자가 새 공고·변경공고를 살펴보는 데 쓴다.
  addedProducts: Array<{ productKey: string; name: string }>;
};

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
    asOfDate: string;
    log: (message: string) => void;
  },
): Promise<{ products: FundingProduct[]; fetchedCount: number; responseChecksum: string }> {
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

  const products: FundingProduct[] = [];
  for (const product of collection.products) {
    products.push(await assignVersion(context.prisma, { ...product, reviewer: AUTO_REVIEWER }));
  }

  // 수집한 상품만으로 카탈로그 검증을 먼저 돌린다. 파서가 필수 항목을 못 찾은 상품이 있으면
  // 그 출처만 실패로 기록하고, 사람이 관리하는 상품과 다른 출처는 그대로 적재한다.
  const validation = validateFundingCatalog(
    {
      catalogKey: context.manual.catalogKey,
      schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
      catalogVersion: `${context.asOfDate}.1`,
      basisDate: context.asOfDate,
      reviewer: context.manual.reviewer,
      notes: [],
      automation: context.manual.automation,
      products,
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
  return { products, fetchedCount: collection.fetchedCount, responseChecksum: collection.responseChecksum };
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
      const collected = await collectSource(adapter, { prisma, manual, previousSync, asOfDate, log });
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

  return {
    catalogFile,
    catalogKey: composed.catalogKey,
    catalogVersion,
    sources,
    manualProductCount: manual.products.length,
    automatedProductCount: keptAutomated.length,
    overriddenByManual,
    load,
  };
}
