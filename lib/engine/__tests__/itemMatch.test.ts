import { describe, it, expect } from 'vitest';
import { normaliseItemName, findMatchingItem } from '../itemMatch';

describe('normaliseItemName', () => {
  it('strips retailer names, range names and pack sizes', () => {
    const key = normaliseItemName('Milk');
    expect(normaliseItemName('Tesco Finest Milk 4 Pints')).toBe(key);
    expect(normaliseItemName("Sainsbury's Taste the Difference Milk 2.27L")).toBe(key);
    expect(normaliseItemName('By Sainsbury’s Milk 1 pint')).toBe(key);
    expect(normaliseItemName('M&S Milk')).toBe(key);
    expect(normaliseItemName('Aldi Specially Selected Milk')).toBe(key);
    expect(normaliseItemName('Lidl Deluxe Milk')).toBe(key);
  });

  it('ignores case, punctuation, word order and plurals', () => {
    expect(normaliseItemName('Semi-Skimmed Milk')).toBe(normaliseItemName('semi skimmed milk'));
    expect(normaliseItemName('Eggs x6')).toBe(normaliseItemName('egg'));
    expect(normaliseItemName('Tomatoes')).toBe(normaliseItemName('Tomato'));
    expect(normaliseItemName('Peaches')).toBe(normaliseItemName('peach'));
    expect(normaliseItemName('Cookies')).toBe(normaliseItemName('Cookie'));
    expect(normaliseItemName('Strawberries')).toBe(normaliseItemName('Strawberry'));
    expect(normaliseItemName('Baked Beans 4 x 415g')).toBe(normaliseItemName('beans baked'));
  });

  it('keeps genuinely different products apart', () => {
    expect(normaliseItemName('Oat Milk')).not.toBe(normaliseItemName('Milk'));
    expect(normaliseItemName('Pears')).not.toBe(normaliseItemName('Peas'));
    expect(normaliseItemName('Hummus')).toBe('hummus');
    expect(normaliseItemName('Couscous')).toBe('couscous');
  });

  it('falls back to the lowercased name when everything is stripped', () => {
    expect(normaliseItemName('Tesco')).toBe('tesco');
  });
});

describe('findMatchingItem', () => {
  const items = [
    { id: '1', name: 'Milk', location: 'fridge' },
    { id: '2', name: 'Milk', location: 'freezer' },
    { id: '3', name: 'Milk', location: 'fridge' }, // pre-existing duplicate
  ];

  it('matches a variant name in the same location, first row wins', () => {
    expect(findMatchingItem('Tesco Milk 4 Pints', 'fridge', items)?.id).toBe('1');
    expect(findMatchingItem('milk', 'freezer', items)?.id).toBe('2');
  });

  it('does not match across locations or different products', () => {
    expect(findMatchingItem('Milk', 'cupboard', items)).toBeUndefined();
    expect(findMatchingItem('Oat Milk', 'fridge', items)).toBeUndefined();
  });

  it('treats names with SQL wildcard characters literally', () => {
    expect(findMatchingItem('M_lk', 'fridge', items)).toBeUndefined();
    expect(findMatchingItem('%', 'fridge', items)).toBeUndefined();
  });
});
