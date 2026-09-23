type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export function consumeRateLimit(
  key: string,
  options: { max: number; windowMs: number },
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [entryKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(entryKey);
      }
      if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value as string);
    }
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true };
  }
  if (current.count >= options.max) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true };
}

export function rateLimitResponse(retryAfterSeconds: number) {
  const response = apiError(429, 'RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  response.headers.set('Retry-After', String(retryAfterSeconds));
  return response;
}
import { apiError } from './api';
