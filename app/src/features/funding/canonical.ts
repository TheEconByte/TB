// PostgreSQL JSONB does not preserve key order, so a stored product is compared
// with the catalog through a canonical serialization instead of raw bytes.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => [key, sortValue(entry)] as const,
    );
    entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}
