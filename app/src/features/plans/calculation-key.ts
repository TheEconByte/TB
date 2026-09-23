import { createHash } from 'node:crypto';

export function calculationKey(
  planId: string,
  inputRevision: number,
  inputSchemaVersion: string,
  calculationVersion: string,
) {
  return createHash('sha256')
    .update(JSON.stringify({ planId, inputRevision, inputSchemaVersion, calculationVersion }))
    .digest('hex');
}
