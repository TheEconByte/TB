export const BUSINESS_DIRECTORY_SCHEMA_VERSION = 'semas-business-directory-v1.0.0';
export const BUSINESS_DIRECTORY_SOURCE_URL = 'https://www.data.go.kr/data/15012005/openapi.do';
export const BUSINESS_DIRECTORY_API_BASE = 'https://apis.data.go.kr/B553077/api/open/sdsc2';

export type BusinessDirectoryRecord = {
  sourceBusinessId: string;
  businessName: string;
  branchName: string | null;
  largeCategoryCode: string;
  largeCategoryName: string;
  middleCategoryCode: string;
  middleCategoryName: string;
  smallCategoryCode: string;
  smallCategoryName: string;
  marketIndustryCode: string | null;
  standardIndustryCode: string | null;
  standardIndustryName: string | null;
  districtCode: string;
  districtName: string;
  administrativeDongCode: string | null;
  administrativeDongName: string | null;
  lotAddress: string | null;
  roadAddress: string | null;
  longitude: string | null;
  latitude: string | null;
};

export type BusinessCategoryInfo = {
  code: string;
  name: string;
  middleCode: string;
  middleName: string;
  marketIndustryCode: string;
  businessCount: number;
  meatCategory: boolean;
};

export type BusinessDirectoryReleaseInfo = {
  releaseKey: string;
  schemaVersion: string;
  sourceUrl: string;
  retrievedAt: string;
  activatedAt: string | null;
  sourceChecksum: string;
  businessCount: number;
};

export type BusinessSummary = {
  competitionScope: {
    kind: 'DETAILED_INDUSTRY';
    code: string;
    label: string;
    statement: string;
  };
  observedScope: null;
  sourceRelease: string;
  asOf: string;
  nullReason: null;
  district: { code: string; name: string };
  category: BusinessCategoryInfo;
  businessCount: number;
  businesses: Array<{
    sourceBusinessId: string;
    businessName: string;
    branchName: string | null;
    roadAddress: string | null;
    lotAddress: string | null;
    longitude: string | null;
    latitude: string | null;
  }>;
  truncated: boolean;
  limitations: string[];
};
