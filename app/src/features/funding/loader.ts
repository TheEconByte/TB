import { readFileSync } from 'node:fs';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../../lib/checksum.ts';
import { canonicalJson } from './canonical.ts';
import { fromDate, toDate } from './dates.ts';
import { assessProductRepayment } from './eligibility.ts';
import { productVersionKey, type FundingCatalog } from './schema.ts';
import { REVIEWER_UNASSIGNED } from './types.ts';
import {
  FundingCatalogError,
  requireValidFundingCatalog,
  type FundingValidationCheck,
  type FundingIssue,
} from './validation.ts';

export type FundingLoadOptions = {
  catalogPath: string;
  prisma: PrismaClient;
  // 판정 기준일(한국 시간). 호출자가 넘기지 않으면 거부한다. 운영 명령은
  // 서버의 한국 시간 날짜를 넘기고, 테스트는 고정 날짜를 넘긴다.
  asOfDate?: string;
  log?: (message: string) => void;
  hooks?: { beforeActivate?: () => Promise<void> | void };
};

export type FundingLoadReport = {
  outcome: 'ACTIVATED' | 'ALREADY_ACTIVE';
  releaseId: string;
  catalogKey: string;
  catalogVersion: string;
  catalogChecksum: string;
  basisDate: string;
  reviewedAt: string | null;
  productCount: number;
  products: string[];
  reviewOverdue: string[];
  warnings: FundingIssue[];
};

export type ParsedFundingCatalogFile = {
  catalog: FundingCatalog;
  catalogChecksum: string;
  asOfDate: string;
  reviewOverdue: string[];
  warnings: FundingIssue[];
  checks: FundingValidationCheck[];
};

// 카탈로그 checksum은 파일 바이트의 SHA-256이다. 같은 파일을 다시 적재하면
// 같은 값이 나오므로 중복 적재를 만들지 않는다.
export function readFundingCatalogFile(
  catalogPath: string,
  asOfDate: string,
  options: { requireAssignedReviewer?: boolean } = {},
): ParsedFundingCatalogFile {
  let bytes: Buffer;
  try {
    bytes = readFileSync(catalogPath);
  } catch {
    throw new FundingCatalogError('CATALOG_FILE_MISSING', `카탈로그 파일을 읽지 못했습니다: ${catalogPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new FundingCatalogError(
      'CATALOG_JSON_INVALID',
      `카탈로그 JSON을 해석하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validation = requireValidFundingCatalog(raw, { asOfDate });
  const catalog = validation.catalog;
  if (catalog === null) {
    throw new FundingCatalogError('CATALOG_VALIDATION_FAILED', '카탈로그 검증 결과가 비어 있습니다.');
  }
  if (
    options.requireAssignedReviewer &&
    (catalog.reviewer === REVIEWER_UNASSIGNED ||
      catalog.products.some((product) => product.reviewer === REVIEWER_UNASSIGNED))
  ) {
    throw new FundingCatalogError(
      'REVIEWER_UNASSIGNED',
      '카탈로그 또는 상품의 검수자가 지정되지 않았습니다. 운영 적재 전에 모든 reviewer를 실제 검수자로 지정하세요.',
    );
  }
  return {
    catalog,
    catalogChecksum: sha256Hex(bytes),
    asOfDate,
    reviewOverdue: validation.reviewOverdue,
    warnings: validation.warnings,
    checks: validation.checks,
  };
}

function productRows(catalog: FundingCatalog) {
  return catalog.products.map((product) => ({
    productKey: product.productKey,
    version: product.version,
    name: product.name,
    organization: product.organization,
    supportType: product.supportType,
    observedApplicationStatus: product.observedApplicationStatus,
    observedAt: toDate(product.observedAt),
    reviewedAt: product.reviewedAt === null ? null : toDate(product.reviewedAt),
    nextReviewAt: product.nextReviewAt === null ? null : toDate(product.nextReviewAt),
    officialUrl: product.officialUrl,
    publicLimit: product.publicLimit,
    repaymentCalculationSupported: assessProductRepayment(product).supported,
    productJson: product,
  }));
}

// 릴리스 검수일은 카탈로그 안 상품 검수일 중 가장 늦은 날짜다.
function latestReviewDate(catalog: FundingCatalog): string | null {
  const dates = catalog.products
    .map((product) => product.reviewedAt)
    .filter((value): value is string => value !== null);
  if (dates.length === 0) return null;
  return dates.reduce((latest, value) => (value > latest ? value : latest));
}

export async function loadFundingCatalog(options: FundingLoadOptions): Promise<FundingLoadReport> {
  const log = options.log ?? (() => {});
  const prisma = options.prisma;
  if (options.asOfDate === undefined) {
    throw new FundingCatalogError(
      'AS_OF_DATE_REQUIRED',
      '판정 기준일(asOfDate)이 필요합니다. 명령은 서버의 한국 시간 날짜를 넘깁니다.',
    );
  }
  const { catalog, catalogChecksum, reviewOverdue, warnings, checks } = readFundingCatalogFile(
    options.catalogPath,
    options.asOfDate,
    { requireAssignedReviewer: true },
  );
  const products = catalog.products.map(productVersionKey);
  const releaseReviewedAt = latestReviewDate(catalog);

  const existing = await prisma.fundingCatalogRelease.findUnique({ where: { catalogChecksum } });
  const sameVersion = await prisma.fundingCatalogRelease.findUnique({
    where: { catalogKey_catalogVersion: { catalogKey: catalog.catalogKey, catalogVersion: catalog.catalogVersion } },
  });
  if (sameVersion && sameVersion.catalogChecksum !== catalogChecksum) {
    throw new FundingCatalogError(
      'CATALOG_VERSION_CONFLICT',
      `같은 catalogKey/version(${catalog.catalogKey}@${catalog.catalogVersion})이 다른 내용으로 이미 적재되어 있습니다. 새 catalogVersion으로 추가하세요.`,
    );
  }
  if (existing && existing.status === 'ACTIVE') {
    log(`같은 checksum의 카탈로그가 이미 활성 상태입니다. 중복 적재하지 않습니다: ${existing.catalogVersion}`);
    return {
      outcome: 'ALREADY_ACTIVE',
      releaseId: existing.id,
      catalogKey: existing.catalogKey,
      catalogVersion: existing.catalogVersion,
      catalogChecksum: existing.catalogChecksum,
      basisDate: fromDate(existing.basisDate),
      reviewedAt: existing.reviewedAt === null ? null : fromDate(existing.reviewedAt),
      productCount: existing.productCount,
      products,
      reviewOverdue,
      warnings,
    };
  }
  if (existing) {
    log(`완료되지 않은 같은 checksum 릴리스(${existing.status})를 정리하고 다시 적재합니다.`);
    await prisma.fundingCatalogRelease.delete({ where: { id: existing.id } });
  }
  const active = await prisma.fundingCatalogRelease.findFirst({ where: { status: 'ACTIVE' } });
  if (active)
    log(`기존 활성 카탈로그는 검증이 끝날 때까지 그대로 서비스됩니다: ${active.catalogKey}@${active.catalogVersion}`);

  const release = await prisma.fundingCatalogRelease.create({
    data: {
      catalogKey: catalog.catalogKey,
      catalogVersion: catalog.catalogVersion,
      catalogChecksum,
      status: 'PENDING',
      schemaVersion: catalog.schemaVersion,
      basisDate: toDate(catalog.basisDate),
      reviewedAt: releaseReviewedAt === null ? null : toDate(releaseReviewedAt),
      reviewer: catalog.reviewer,
      sourceDocuments: catalog.products.flatMap((product) =>
        product.evidence.map((entry) => ({
          productKey: product.productKey,
          version: product.version,
          id: entry.id,
          subject: entry.subject,
          sourceUrl: entry.sourceUrl,
          sourceDocumentName: entry.sourceDocumentName,
          observedAt: entry.observedAt,
          retrievalMethod: entry.retrievalMethod,
          checksum: entry.checksum,
        })),
      ),
      productVersions: products,
      validationSummary: { checks, warnings, reviewOverdue, asOfDate: options.asOfDate, productCount: products.length },
      productCount: products.length,
    },
  });
  log(
    `임시 카탈로그 릴리스 ${release.id} 생성(${catalog.catalogKey}@${catalog.catalogVersion}). 활성화 전까지 후보로 쓰지 않습니다.`,
  );

  const createdIds: string[] = [];
  try {
    for (const [position, row] of productRows(catalog).entries()) {
      const existingVersion = await prisma.fundingProductVersion.findUnique({
        where: { productKey_version: { productKey: row.productKey, version: row.version } },
      });
      if (existingVersion) {
        if (canonicalJson(existingVersion.productJson) !== canonicalJson(row.productJson)) {
          throw new FundingCatalogError(
            'PRODUCT_VERSION_IMMUTABLE',
            `이미 적재된 상품 버전 ${row.productKey}@${row.version}의 내용이 다릅니다. 상품 버전은 덮어쓰지 않으며 새 버전으로 추가해야 합니다.`,
          );
        }
        log(`이미 적재된 상품 버전을 재사용합니다: ${row.productKey}@${row.version}`);
      }
      const storedVersion = existingVersion ?? (await prisma.fundingProductVersion.create({ data: row }));
      if (!existingVersion) {
        createdIds.push(storedVersion.id);
        log(`상품 버전 적재: ${row.productKey}@${row.version} (${row.supportType}, ${row.observedApplicationStatus})`);
      }
      await prisma.fundingCatalogProduct.create({
        data: { catalogReleaseId: release.id, productVersionId: storedVersion.id, position },
      });
    }

    const missing: string[] = [];
    for (const product of catalog.products) {
      const stored = await prisma.fundingProductVersion.findUnique({
        where: { productKey_version: { productKey: product.productKey, version: product.version } },
        select: { productJson: true },
      });
      if (!stored || canonicalJson(stored.productJson) !== canonicalJson(product))
        missing.push(productVersionKey(product));
    }
    if (missing.length > 0) {
      throw new FundingCatalogError(
        'DB_VERIFICATION',
        `적재 후 검증에 실패했습니다. 저장된 상품 버전이 카탈로그와 다릅니다: ${missing.join(', ')}`,
      );
    }
    const membershipCount = await prisma.fundingCatalogProduct.count({ where: { catalogReleaseId: release.id } });
    if (membershipCount !== products.length) {
      throw new FundingCatalogError(
        'DB_VERIFICATION',
        `적재 후 릴리스-상품 연결 수가 다릅니다: expected=${products.length}, actual=${membershipCount}`,
      );
    }

    if (options.hooks?.beforeActivate) await options.hooks.beforeActivate();

    await prisma.$transaction(async (transaction) => {
      await transaction.fundingCatalogRelease.updateMany({
        where: { status: 'ACTIVE', id: { not: release.id } },
        data: { status: 'SUPERSEDED' },
      });
      await transaction.fundingCatalogRelease.update({
        where: { id: release.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      });
    });
  } catch (error) {
    const reason =
      error instanceof FundingCatalogError
        ? `FundingCatalogError [${error.code}]: ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    try {
      await prisma.fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: release.id } });
      if (createdIds.length > 0) {
        await prisma.fundingProductVersion.deleteMany({ where: { id: { in: createdIds } } });
      }
      await prisma.fundingCatalogRelease.update({
        where: { id: release.id },
        data: { status: 'FAILED', failedAt: new Date(), failureReason: reason.slice(0, 2000) },
      });
      log('실패한 카탈로그가 만든 상품 버전만 지웠습니다. 기존 활성 카탈로그는 그대로 유지됩니다.');
    } catch (cleanupError) {
      log(`실패 카탈로그 정리 중 오류: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw error;
  }

  log(`카탈로그 ${catalog.catalogKey}@${catalog.catalogVersion}를 활성화했습니다.`);
  return {
    outcome: 'ACTIVATED',
    releaseId: release.id,
    catalogKey: catalog.catalogKey,
    catalogVersion: catalog.catalogVersion,
    catalogChecksum,
    basisDate: catalog.basisDate,
    reviewedAt: releaseReviewedAt,
    productCount: products.length,
    products,
    reviewOverdue,
    warnings,
  };
}
