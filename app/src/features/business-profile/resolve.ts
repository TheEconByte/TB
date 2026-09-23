import type { PrismaClient } from '../../generated/prisma/client.ts';
import { resolveDetailedCategory } from '../business-directory/read.ts';
import { districtName } from '../funding/districts.ts';
import { findActiveRelease } from '../market/read.ts';
import type { BusinessProfileInput, StoredBusinessProfile } from './schema.ts';

export type ResolveBusinessProfileOutcome =
  | { kind: 'OK'; profile: StoredBusinessProfile }
  | { kind: 'MARKET_RELEASE_UNAVAILABLE' }
  | { kind: 'INDUSTRY_NOT_FOUND' }
  | { kind: 'DETAIL_RELEASE_UNAVAILABLE_OR_MISMATCHED' };

export async function resolveBusinessProfile(
  prisma: PrismaClient,
  input: BusinessProfileInput,
): Promise<ResolveBusinessProfileOutcome> {
  const release = await findActiveRelease(prisma);
  if (!release) return { kind: 'MARKET_RELEASE_UNAVAILABLE' };
  const industry = await prisma.industry.findUnique({
    where: { releaseId_code: { releaseId: release.id, code: input.marketIndustryCode } },
  });
  if (!industry?.isSupported) return { kind: 'INDUSTRY_NOT_FOUND' };
  const detail =
    input.detailedIndustryCode === null
      ? null
      : await resolveDetailedCategory(prisma, input.detailedIndustryCode, input.marketIndustryCode);
  if (input.detailedIndustryCode !== null && detail === null)
    return { kind: 'DETAIL_RELEASE_UNAVAILABLE_OR_MISMATCHED' };
  return {
    kind: 'OK',
    profile: {
      schemaVersion: 'business-profile-v1.0.0',
      ...input,
      districtName: districtName(input.districtCode) ?? input.districtCode,
      marketIndustryName: industry.displayName,
      detailedIndustryName: detail?.name ?? null,
      provenance: { marketReleaseKey: release.releaseKey, businessDirectoryReleaseKey: detail?.releaseKey ?? null },
    },
  };
}
