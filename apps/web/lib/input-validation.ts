// Page-boundary input validation mirroring the backend contracts so invalid
// input becomes a recoverable message/404 instead of the generic page error
// boundary. Bounds mirror apps/backend/src/db.rs MAX_SEARCH_QUERY_LENGTH /
// MAX_SEARCH_TERMS; the UUID shape mirrors Uuid::parse_str expectations.
export const MAX_SEARCH_QUERY_LENGTH = 128;
export const MAX_SEARCH_TERMS = 8;

export function validateSearchQuery(query: string): string | null {
  // Spread counts Unicode scalar values like Rust's chars().count().
  if ([...query].length > MAX_SEARCH_QUERY_LENGTH) {
    return `Search must be at most ${MAX_SEARCH_QUERY_LENGTH} characters.`;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.split(/\s+/).length > MAX_SEARCH_TERMS) {
    return `Search must have at most ${MAX_SEARCH_TERMS} terms.`;
  }
  return null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRouteUuid(value: string) {
  return UUID_PATTERN.test(value);
}
