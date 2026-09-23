import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../market/checksum.ts';
import { SEOUL_DISTRICTS } from '../funding/districts.ts';
import { marketIndustryForSemas } from './mapping.ts';
import {
  BUSINESS_DIRECTORY_API_BASE,
  BUSINESS_DIRECTORY_SCHEMA_VERSION,
  BUSINESS_DIRECTORY_SOURCE_URL,
  type BusinessDirectoryRecord,
} from './types.ts';

export class BusinessDirectoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BusinessDirectoryError';
  }
}

type ApiEnvelope = {
  header?: { resultCode?: unknown; resultMsg?: unknown; columns?: unknown };
  body?: { items?: unknown; totalCount?: unknown; pageNo?: unknown; numOfRows?: unknown };
};

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText === '' ? null : valueText;
}

function objectItem(raw: unknown, columns: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (!Array.isArray(raw) || !Array.isArray(columns)) return null;
  return Object.fromEntries(columns.map((column, index) => [String(column), raw[index]]));
}

export function parseBusinessDirectoryPage(payload: unknown): {
  totalCount: number;
  records: BusinessDirectoryRecord[];
} {
  if (!payload || typeof payload !== 'object')
    throw new BusinessDirectoryError('INVALID_RESPONSE', '소진공 API 응답이 JSON 객체가 아닙니다.');
  const envelope = payload as ApiEnvelope;
  const resultCode = text(envelope.header?.resultCode);
  if (resultCode !== '' && resultCode !== '00' && resultCode !== '0') {
    throw new BusinessDirectoryError(
      'UPSTREAM_ERROR',
      `소진공 API 오류 ${resultCode}: ${text(envelope.header?.resultMsg) || '상세 메시지 없음'}`,
    );
  }
  const rawItems = envelope.body?.items;
  const items = Array.isArray(rawItems) ? rawItems : rawItems == null ? [] : [rawItems];
  const records: BusinessDirectoryRecord[] = [];
  for (const raw of items) {
    const item = objectItem(raw, envelope.header?.columns);
    if (!item) throw new BusinessDirectoryError('INVALID_RESPONSE', '소진공 API 업소 항목 형식이 올바르지 않습니다.');
    const sourceBusinessId = text(item.bizesId);
    const businessName = text(item.bizesNm);
    const smallCategoryCode = text(item.indsSclsCd);
    const smallCategoryName = text(item.indsSclsNm);
    const middleCategoryCode = text(item.indsMclsCd);
    const middleCategoryName = text(item.indsMclsNm);
    const largeCategoryCode = text(item.indsLclsCd);
    const largeCategoryName = text(item.indsLclsNm);
    const districtCode = text(item.signguCd);
    const districtName = text(item.signguNm);
    if (
      !sourceBusinessId ||
      !businessName ||
      !smallCategoryCode ||
      !smallCategoryName ||
      !districtCode ||
      !districtName
    ) {
      throw new BusinessDirectoryError('INVALID_RESPONSE', '소진공 API 필수 업소·업종·자치구 값이 비어 있습니다.');
    }
    records.push({
      sourceBusinessId,
      businessName,
      branchName: nullableText(item.brchNm),
      largeCategoryCode,
      largeCategoryName,
      middleCategoryCode,
      middleCategoryName,
      smallCategoryCode,
      smallCategoryName,
      marketIndustryCode: marketIndustryForSemas({
        middleName: middleCategoryName,
        smallCode: smallCategoryCode,
        smallName: smallCategoryName,
      }),
      standardIndustryCode: nullableText(item.ksicCd),
      standardIndustryName: nullableText(item.ksicNm),
      districtCode,
      districtName,
      administrativeDongCode: nullableText(item.adongCd),
      administrativeDongName: nullableText(item.adongNm),
      lotAddress: nullableText(item.lnoAdr),
      roadAddress: nullableText(item.rdnmAdr),
      longitude: nullableText(item.lon),
      latitude: nullableText(item.lat),
    });
  }
  const totalCount = Number(text(envelope.body?.totalCount) || records.length);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0)
    throw new BusinessDirectoryError('INVALID_RESPONSE', '소진공 API totalCount가 올바르지 않습니다.');
  return { totalCount, records };
}

async function fetchDistrict(
  options: Readonly<{
    districtCode: string;
    serviceKey: string;
    fetcher: typeof fetch;
    log: (message: string) => void;
  }>,
) {
  const rows: BusinessDirectoryRecord[] = [];
  const pageSize = 1000;
  let pageNo = 1;
  let totalCount = Number.POSITIVE_INFINITY;
  while (rows.length < totalCount) {
    const url = new URL(`${BUSINESS_DIRECTORY_API_BASE}/storeListInDong`);
    url.searchParams.set('ServiceKey', options.serviceKey);
    url.searchParams.set('divId', 'signguCd');
    url.searchParams.set('key', options.districtCode);
    url.searchParams.set('indsLclsCd', 'I2');
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('numOfRows', String(pageSize));
    url.searchParams.set('type', 'json');
    const response = await options.fetcher(url, { headers: { accept: 'application/json' } });
    if (!response.ok)
      throw new BusinessDirectoryError(
        'HTTP_ERROR',
        `소진공 API ${options.districtCode} ${pageNo}페이지가 HTTP ${response.status}를 반환했습니다.`,
      );
    const page = parseBusinessDirectoryPage(await response.json());
    totalCount = page.totalCount;
    rows.push(...page.records);
    options.log(`${options.districtCode}: ${Math.min(rows.length, totalCount)}/${totalCount}건 수집`);
    if (page.records.length === 0) break;
    pageNo += 1;
  }
  if (rows.length !== totalCount)
    throw new BusinessDirectoryError(
      'INCOMPLETE_RESPONSE',
      `${options.districtCode}: 기대 ${totalCount}건 중 ${rows.length}건만 수집했습니다.`,
    );
  return rows;
}

function canonicalChecksum(records: readonly BusinessDirectoryRecord[]): string {
  return sha256Hex(JSON.stringify([...records].sort((a, b) => a.sourceBusinessId.localeCompare(b.sourceBusinessId))));
}

async function markFailed(prisma: PrismaClient, releaseId: string, error: unknown) {
  await prisma.businessLocation.deleteMany({ where: { releaseId } });
  await prisma.businessDirectoryRelease.update({
    where: { id: releaseId },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      failureReason: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    },
  });
}

export async function loadBusinessDirectory(
  options: Readonly<{
    prisma: PrismaClient;
    serviceKey: string;
    retrievedAt?: Date;
    fetcher?: typeof fetch;
    log?: (message: string) => void;
  }>,
) {
  if (options.serviceKey.trim() === '')
    throw new BusinessDirectoryError('SERVICE_KEY_MISSING', 'SEMAS_SERVICE_KEY가 없습니다.');
  const log = options.log ?? (() => {});
  const fetcher = options.fetcher ?? fetch;
  const records: BusinessDirectoryRecord[] = [];
  // Keep API traffic predictable and below the public gateway's burst limit.
  for (const district of SEOUL_DISTRICTS) {
    records.push(
      ...(await fetchDistrict({ districtCode: district.code, serviceKey: options.serviceKey, fetcher, log })),
    );
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.sourceBusinessId))
      throw new BusinessDirectoryError('DUPLICATE_BUSINESS', `중복 상가업소번호: ${record.sourceBusinessId}`);
    seen.add(record.sourceBusinessId);
  }
  const mappedRecords = records.filter((record) => record.marketIndustryCode !== null);
  if (mappedRecords.length === 0)
    throw new BusinessDirectoryError(
      'NO_SUPPORTED_BUSINESS',
      '한식·커피 업종으로 매핑된 업소가 없어 릴리스를 활성화하지 않습니다.',
    );
  const retrievedAt = options.retrievedAt ?? new Date();
  const sourceChecksum = canonicalChecksum(mappedRecords);
  const releaseKey = `semas-seoul-food-${retrievedAt.toISOString().slice(0, 10).replaceAll('-', '')}-${sourceChecksum.slice(0, 12)}`;
  const existing = await options.prisma.businessDirectoryRelease.findUnique({ where: { releaseKey } });
  if (existing?.status === 'ACTIVE')
    return {
      outcome: 'ALREADY_ACTIVE' as const,
      releaseKey,
      releaseId: existing.id,
      businessCount: existing.businessCount,
    };
  if (existing) await options.prisma.businessDirectoryRelease.delete({ where: { id: existing.id } });
  const release = await options.prisma.businessDirectoryRelease.create({
    data: {
      releaseKey,
      schemaVersion: BUSINESS_DIRECTORY_SCHEMA_VERSION,
      sourceUrl: BUSINESS_DIRECTORY_SOURCE_URL,
      retrievedAt,
      sourceChecksum,
      sourceMetadata: {
        endpoint: `${BUSINESS_DIRECTORY_API_BASE}/storeListInDong`,
        districts: SEOUL_DISTRICTS.map((item) => item.code),
        largeCategoryFilter: 'I2',
      },
      validationSummary: { fetchedCount: records.length, supportedCount: mappedRecords.length, duplicateCount: 0 },
      businessCount: mappedRecords.length,
    },
  });
  try {
    const chunkSize = 2000;
    for (let index = 0; index < mappedRecords.length; index += chunkSize) {
      await options.prisma.businessLocation.createMany({
        data: mappedRecords
          .slice(index, index + chunkSize)
          .map((record) => ({ ...record, releaseId: release.id })) as Prisma.BusinessLocationCreateManyInput[],
      });
    }
    const persisted = await options.prisma.businessLocation.count({ where: { releaseId: release.id } });
    if (persisted !== mappedRecords.length)
      throw new BusinessDirectoryError(
        'DB_VERIFICATION',
        `적재 ${persisted}건이 검증값 ${mappedRecords.length}건과 다릅니다.`,
      );
    await options.prisma.$transaction([
      options.prisma.businessDirectoryRelease.updateMany({
        where: { status: 'ACTIVE', id: { not: release.id } },
        data: { status: 'SUPERSEDED' },
      }),
      options.prisma.businessDirectoryRelease.update({
        where: { id: release.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      }),
    ]);
  } catch (error) {
    await markFailed(options.prisma, release.id, error);
    throw error;
  }
  return { outcome: 'ACTIVATED' as const, releaseKey, releaseId: release.id, businessCount: mappedRecords.length };
}
