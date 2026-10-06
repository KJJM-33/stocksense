/**
 * StockSense Intelligence Engine — Dashboard Item Search
 *
 * Unlike itemMatch (which decides whether two names are the *same* item), search
 * is deliberately loose: case-insensitive substring match on every search term, in
 * any order — "milk oat" finds "Oat Milk", "mil" finds "Milk" and "Oat Milk".
 */

/** Split a raw query into lowercase terms; empty/whitespace-only → no terms. */
export function searchTerms(query: string | null | undefined): string[] {
  return (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/** True if `name` contains every term. No terms → everything matches. */
export function matchesSearch(name: string, terms: string[]): boolean {
  const haystack = name.toLowerCase();
  return terms.every(term => haystack.includes(term));
}
