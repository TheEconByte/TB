import { createHash } from 'node:crypto';

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}
// Stable fingerprint of a release's source content. Re-running the loader on the
// same bytes produces the same value, which is what makes reloads idempotent.
export function contentHash(entries: readonly { file: string; sha256: string }[]): string {
  const canonical = [...entries]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map((entry) => `${entry.file}:${entry.sha256}`)
    .join('\n');
  return sha256Hex(canonical);
}
