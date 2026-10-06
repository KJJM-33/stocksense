import { describe, it, expect } from 'vitest';
import { searchTerms, matchesSearch } from '../itemSearch';

describe('searchTerms', () => {
  it('lowercases and splits on whitespace', () => {
    expect(searchTerms('  Oat   MILK ')).toEqual(['oat', 'milk']);
  });

  it('returns no terms for empty, whitespace-only or missing queries', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms(undefined)).toEqual([]);
    expect(searchTerms(null)).toEqual([]);
  });
});

describe('matchesSearch', () => {
  it('matches everything when there are no terms', () => {
    expect(matchesSearch('Eggs', [])).toBe(true);
  });

  it('is a case-insensitive substring match', () => {
    expect(matchesSearch('Oat Milk', searchTerms('mil'))).toBe(true);
    expect(matchesSearch('Milk', searchTerms('MILK'))).toBe(true);
    expect(matchesSearch('Eggs', searchTerms('milk'))).toBe(false);
  });

  it('requires every term, in any order', () => {
    expect(matchesSearch('Oat Milk', searchTerms('milk oat'))).toBe(true);
    expect(matchesSearch('Milk', searchTerms('oat milk'))).toBe(false);
  });
});
