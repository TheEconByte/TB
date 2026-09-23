import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'REVISION_CONFLICT'
  | 'INTERNAL_ERROR'
  | 'CATALOG_UNAVAILABLE'
  | 'RELEASE_UNAVAILABLE'
  | 'BUSINESS_DIRECTORY_UNAVAILABLE'
  | 'BUSINESS_CATEGORY_NOT_FOUND'
  | 'BUSINESS_PROFILE_UNAVAILABLE'
  | 'MARKET_RELEASE_UNAVAILABLE'
  | 'INDUSTRY_NOT_FOUND'
  | 'DETAIL_CATEGORY_UNAVAILABLE'
  | 'DATASET_UNAVAILABLE'
  | 'INVALID_DISTRICT_CODE'
  | 'INVALID_AREA_CODE'
  | 'AREA_NOT_FOUND'
  | 'AMBIGUOUS_AREA_CODE'
  | 'INVALID_INDUSTRY_CODE'
  | 'UNSUPPORTED_INDUSTRY'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED';

export function apiError(status: number, code: ApiErrorCode, message: string, fields?: unknown) {
  return NextResponse.json({ error: { code, message, ...(fields ? { fields } : {}) } }, { status });
}

export function invalidZod(error: ZodError) {
  return apiError(400, 'INVALID_INPUT', '요청 값을 확인해 주세요.', error.flatten());
}

export function internalError(error: unknown) {
  console.error(
    'Request failed',
    error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
  );
  return apiError(500, 'INTERNAL_ERROR', '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}
