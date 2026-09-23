import { NextResponse } from 'next/server';
import { apiError } from './api';

const MAX_JSON_BODY_BYTES = 64 * 1024;

function configuredOrigin(): string | null {
  const value = process.env.BETTER_AUTH_URL;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Better Auth가 처리하는 인증 경로 밖의 업무 mutation에도 같은 출처 경계를 둔다.
// 브라우저는 Origin 또는 Fetch Metadata를 보내므로 동일 사이트의 다른 서브도메인에서
// 세션 쿠키를 이용하는 요청도 차단한다. 헤더가 없는 서버 간 호출과 테스트는 허용한다.
export function guardMutationRequest(request: Request, options: { requireJson?: boolean } = {}): NextResponse | null {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    return apiError(403, 'FORBIDDEN', '허용되지 않은 출처의 요청입니다.');
  }

  const origin = request.headers.get('origin');
  if (origin) {
    const allowed = new Set(
      [new URL(request.url).origin, configuredOrigin()].filter((value): value is string => value !== null),
    );
    if (!allowed.has(origin)) return apiError(403, 'FORBIDDEN', '허용되지 않은 출처의 요청입니다.');
  }

  if (options.requireJson) {
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type은 application/json이어야 합니다.');
    }
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_JSON_BODY_BYTES) {
      return apiError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.');
    }
  }
  return null;
}
