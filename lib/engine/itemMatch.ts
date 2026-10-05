/**
 * StockSense Intelligence Engine — Item Name Matching
 *
 * Receipt, scan, and email-receipt imports name items via a Claude prompt, which
 * shortens names but not reliably ("Tesco Finest Semi-Skimmed Milk 4 Pints" vs
 * "Semi Skimmed Milk" vs "semi-skimmed milk"). Without a programmatic match each
 * variant becomes its own `items` row.
 *
 * Deliberately conservative: two names match only if their normalised keys are
 * identical. No edit-distance or substring matching — "Oat Milk" must not merge
 * into "Milk", and "Pears" must not merge into "Peas".
 */

/** UK supermarket names and own-label range names, stripped before comparison. */
const RETAILER_PHRASES = [
  'marks and spencer', 'marks & spencer', 'm&s', 'm & s',
  'taste the difference', 'by sainsbury\'s', 'sainsbury\'s', 'sainsburys',
  'tesco finest', 'tesco everyday value', 'tesco',
  'specially selected', 'aldi',
  'lidl deluxe', 'deluxe', 'lidl',
  'extra special', 'asda',
  'waitrose essential', 'waitrose',
  'morrisons the best', 'morrisons',
  'co-op', 'coop', 'ocado', 'iceland', 'finest',
];

const SIZE_UNITS = 'ml|cl|l|ltr|litres?|g|kg|pints?|pt|packs?|pk|rolls?|sheets?|ct';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RETAILER_RE = new RegExp(
  `(^|\\s)(${RETAILER_PHRASES.map(escapeRegExp).join('|')})(?=\\s|$)`,
  'g'
);
// "4 pints", "500g", "2.27l", "6 x 330ml", "x6", "6x"
const SIZE_RE = new RegExp(
  `\\b\\d+(\\.\\d+)?\\s*(x\\s*\\d+(\\.\\d+)?\\s*)?(${SIZE_UNITS})\\b|\\bx\\s*\\d+\\b|\\b\\d+\\s*x\\b`,
  'g'
);

function singularise(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith('oes')) t = t.slice(0, -2);
  else if (t.length > 4 && /(ches|shes|sses|xes)$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  // cookies/cookie and berries/berry both land on the same key
  if (t.endsWith('ie')) t = t.slice(0, -2) + 'y';
  return t;
}

/**
 * Comparison key for an item name: lowercased, retailer/range names and pack
 * sizes removed, punctuation stripped, tokens singularised and sorted.
 * Falls back to the plain lowercased name if normalisation strips everything.
 */
export function normaliseItemName(name: string): string {
  const lower = name.toLowerCase().replace(/[’‘]/g, '\'').trim();
  const stripped = lower
    .replace(RETAILER_RE, ' ')
    .replace(SIZE_RE, ' ')
    .replace(/[^a-z\s]/g, ' ');
  const tokens = stripped.split(/\s+/).filter(Boolean).map(singularise).sort();
  return tokens.length > 0 ? tokens.join(' ') : lower;
}

/**
 * Finds an existing item that is the same product in the same location.
 * Returns the first match, so pre-existing duplicate rows don't cause a failure.
 */
export function findMatchingItem<T extends { name: string; location: string | null }>(
  name: string,
  location: string,
  candidates: T[]
): T | undefined {
  const key = normaliseItemName(name);
  return candidates.find(
    (c) => c.location === location && normaliseItemName(c.name) === key
  );
}
