import { describe, expect, it } from 'vitest';
import { consumeRateLimit, rateLimitResponse } from './rate-limit';
import { guardMutationRequest } from './request-security';

describe('mutation 요청 보안 경계', () => {
  it('교차 출처와 cross-site 요청을 거부한다', async () => {
    for (const headers of [
      new Headers({ origin: 'https://evil.example', 'content-type': 'application/json' }),
      new Headers({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }),
    ]) {
      const response = guardMutationRequest(new Request('https://trendbench.example/api/plans', { headers }), {
        requireJson: true,
      });
      expect(response?.status).toBe(403);
      expect((await response?.json()).error.code).toBe('FORBIDDEN');
    }
  });

  it('JSON 콘텐츠 유형과 64 KiB 본문 한도를 강제한다', async () => {
    const unsupported = guardMutationRequest(
      new Request('https://trendbench.example/api/plans', { headers: { 'content-type': 'text/plain' } }),
      { requireJson: true },
    );
    expect(unsupported?.status).toBe(415);

    const oversized = guardMutationRequest(
      new Request('https://trendbench.example/api/plans', {
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) },
      }),
      { requireJson: true },
    );
    expect(oversized?.status).toBe(413);
  });

  it('동일 출처 JSON 요청은 허용한다', () => {
    const request = new Request('https://trendbench.example/api/plans', {
      headers: { origin: 'https://trendbench.example', 'content-type': 'application/json; charset=utf-8' },
    });
    expect(guardMutationRequest(request, { requireJson: true })).toBeNull();
  });
});

describe('변경 API 요청 빈도 제한', () => {
  it('윈도우 한도를 넘으면 재시도 시간을 포함한 429를 만든다', () => {
    const key = `test-${crypto.randomUUID()}`;
    expect(consumeRateLimit(key, { max: 1, windowMs: 60_000 })).toEqual({ allowed: true });
    const denied = consumeRateLimit(key, { max: 1, windowMs: 60_000 });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    const response = rateLimitResponse(denied.retryAfterSeconds);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
