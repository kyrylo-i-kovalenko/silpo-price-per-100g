/**
 * Silpo Price Calculator: pure logic (parsing, unit prices, ranking).
 *
 * No DOM access here, so everything in this file is covered by plain Node
 * unit tests. In the browser it is loaded as the first content script and
 * exposes `globalThis.SilpoPriceCore`; in Node it is a CommonJS module.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SilpoPriceCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Pack-size units and how to convert them to the base unit we compare in. */
  const UNITS = {
    'кг': { base: 'g', factor: 1000 },
    kg: { base: 'g', factor: 1000 },
    'гр': { base: 'g', factor: 1 },
    'г': { base: 'g', factor: 1 },
    g: { base: 'g', factor: 1 },
    'мл': { base: 'ml', factor: 1 },
    ml: { base: 'ml', factor: 1 },
    'л': { base: 'ml', factor: 1000 },
    l: { base: 'ml', factor: 1000 },
    'штук': { base: 'pcs', factor: 1 },
    'шт': { base: 'pcs', factor: 1 },
    pcs: { base: 'pcs', factor: 1 },
  };

  /** Unit price is shown per 100 g, per 100 ml or per 1 piece. */
  const PER = { g: 100, ml: 100, pcs: 1 };
  const UNIT_LABEL = { g: 'г', ml: 'мл', pcs: 'шт' };

  // "900г", "1,5 л", "6×1.5л", "4 x 100 г", "6 х 0,5 л" (Cyrillic "х"), "10 шт".
  // Longer unit names go first in the alternation; the lookahead stops
  // "79.99 гривень" from being read as 79.99 g and "1 лимон" as 1 l.
  const QUANTITY_RE = new RegExp(
    '(?:(\\d+)\\s*[x×х*]\\s*)?' +
      '(\\d+(?:[.,]\\d+)?)\\s*' +
      '(кг|kg|гр|г|g|мл|ml|л|l|штук|шт|pcs)' +
      '(?![a-zа-яіїєґ])'
  );
  // Weighed goods sometimes show only the unit: "кг", "за кг".
  const BARE_UNIT_RE = /^(?:за\s*)?(кг|kg|л|l)\.?$/;

  function normalize(text) {
    return String(text)
      .toLowerCase()
      .replace(/[\u00a0\u202f]/g, ' ')
      .trim();
  }

  function toNumber(str) {
    return parseFloat(str.replace(',', '.'));
  }

  function isPositive(n) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
  }

  /**
   * Parses a pack size.
   * @param {string} text e.g. "900г", "1,5л", "6×1.5 л", "10 шт"
   * @returns {{amount: number, base: 'g'|'ml'|'pcs'} | null}
   *   amount is in grams, millilitres or pieces.
   */
  function parseQuantity(text) {
    if (text == null) return null;
    const s = normalize(text);
    if (!s) return null;

    const m = s.match(QUANTITY_RE);
    if (m) {
      const count = m[1] ? parseInt(m[1], 10) : 1;
      const unit = UNITS[m[3]];
      const amount = count * toNumber(m[2]) * unit.factor;
      return isPositive(amount) ? { amount, base: unit.base } : null;
    }

    const bare = s.match(BARE_UNIT_RE);
    if (bare) {
      const unit = UNITS[bare[1]];
      return { amount: unit.factor, base: unit.base };
    }
    return null;
  }

  /**
   * Parses a price such as " 64.90 грн ", "48,90грн" or "1 299.00 грн".
   * @returns {number | null}
   */
  function parsePrice(text) {
    if (text == null) return null;
    const s = String(text)
      .replace(/[\u00a0\u202f]/g, ' ')
      // join thousands groups only: "1 299.00" -> "1299.00"
      .replace(/(\d) (?=\d{3}(?!\d))/g, '$1');
    const m = s.match(/\d+(?:[.,]\d+)?/);
    if (!m) return null;
    const value = toNumber(m[0]);
    return isPositive(value) ? value : null;
  }

  /**
   * Price per 100 g / 100 ml / 1 piece.
   * Returns null for a single piece: its unit price equals the shelf price.
   * @returns {{value: number, per: number, base: string} | null}
   */
  function unitPrice(price, quantity) {
    if (!isPositive(price) || !quantity || !isPositive(quantity.amount)) return null;
    if (quantity.base === 'pcs' && quantity.amount < 2) return null;
    const per = PER[quantity.base];
    return { value: (price / quantity.amount) * per, per, base: quantity.base };
  }

  /** "100 г", "100 мл", "шт" */
  function perLabel(unit) {
    const name = UNIT_LABEL[unit.base];
    return unit.per === 1 ? name : unit.per + ' ' + name;
  }

  /** "6.89" (two decimals, dot, the same style Silpo uses for prices) */
  function formatMoney(value) {
    return value.toFixed(2);
  }

  /** Linear-interpolated quantile of an ascending array. */
  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * Builds a classifier for one comparison group (same list, same unit).
   *
   * Tiers come from each product's rank, not from its distance to the
   * min/max: the cheapest third is "best", the most expensive third is
   * "worst". A min-max scale (v3) let one outlier, such as a 400 g flavoured
   * drink in the milk aisle, push almost everything else into "best".
   * Equal prices get the same mid-rank, so they always share a tier.
   *
   * @param {number[]} values unit prices of the group
   * @param {number} [minGroupSize=3]
   * @returns {(value: number) => {tier: string, n: number, median: number,
   *   reason?: string, cheaperThanPct?: number}}
   */
  function createRanker(values, minGroupSize = 3) {
    const sorted = values.filter(isPositive).sort((a, b) => a - b);
    const n = sorted.length;
    const median = n ? quantile(sorted, 0.5) : NaN;

    if (n < minGroupSize) {
      return () => ({ tier: 'neutral', reason: 'few', n, median });
    }
    const min = sorted[0];
    const max = sorted[n - 1];
    if (max - min <= max * 0.005) {
      return () => ({ tier: 'neutral', reason: 'same', n, median });
    }

    return (value) => {
      const below = sorted.filter((v) => v < value).length;
      const above = sorted.filter((v) => v > value).length;
      const equal = n - below - above;
      // mid-rank is 0..n-1; comparing 3*rank with (n-1) and 2*(n-1) avoids float edge cases
      const rank3 = 3 * (below + (equal - 1) / 2);
      const tier = rank3 < n - 1 ? 'best' : rank3 > 2 * (n - 1) ? 'worst' : 'average';
      const cheaperThanPct = Math.round((above / (n - 1)) * 100);
      return { tier, n, median, cheaperThanPct };
    };
  }

  return {
    parseQuantity,
    parsePrice,
    unitPrice,
    perLabel,
    formatMoney,
    createRanker,
  };
});
