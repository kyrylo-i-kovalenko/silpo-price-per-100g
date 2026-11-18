'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

// Unit prices (грн per 100 г) of the 45 gram-priced cards on
// silpo.ua/category/moloko-253, November 2026. Includes three outliers:
// flavoured milk drinks at 21.22 and 28.50.
const MILK_PAGE = [
  7.21, 6.89, 7.26, 8.42, 6.7, 5.2, 6.67, 8.91, 8.05, 8.7, 10.9, 9.6, 6.53, 6.5, 21.22, 7.27,
  10.2, 8.95, 7.79, 9.37, 7.33, 7.53, 8.95, 8.28, 8.3, 9.2, 6.39, 8.1, 12, 28.5, 7.84, 21.22,
  28.5, 7.26, 9.55, 9.16, 6.8, 7.73, 8.68, 7.22, 8.55, 9.89, 11.47, 6.17, 9.59,
];

const tally = (values) => {
  const rank = core.createRanker(values);
  return values.reduce((acc, v) => {
    const { tier } = rank(v);
    acc[tier] = (acc[tier] || 0) + 1;
    return acc;
  }, {});
};

test('parseQuantity: grams, kilograms, millilitres, litres', () => {
  assert.deepEqual(core.parseQuantity('900г'), { amount: 900, base: 'g' });
  assert.deepEqual(core.parseQuantity('1кг'), { amount: 1000, base: 'g' });
  assert.deepEqual(core.parseQuantity('0,5 кг'), { amount: 500, base: 'g' });
  assert.deepEqual(core.parseQuantity('500 g'), { amount: 500, base: 'g' });
  assert.deepEqual(core.parseQuantity(' 920 мл '), { amount: 920, base: 'ml' });
  assert.deepEqual(core.parseQuantity('1,5л'), { amount: 1500, base: 'ml' });
  assert.deepEqual(core.parseQuantity('0.9 L'), { amount: 900, base: 'ml' });
});

test('parseQuantity: multipacks are multiplied', () => {
  assert.deepEqual(core.parseQuantity('6×1.5л'), { amount: 9000, base: 'ml' });
  assert.deepEqual(core.parseQuantity('4 x 100 г'), { amount: 400, base: 'g' });
  assert.deepEqual(core.parseQuantity('6 х 0,5 л'), { amount: 3000, base: 'ml' }); // Cyrillic х
  assert.deepEqual(core.parseQuantity('2*200г'), { amount: 400, base: 'g' });
});

test('parseQuantity: pieces and weighed goods', () => {
  assert.deepEqual(core.parseQuantity('10 шт'), { amount: 10, base: 'pcs' });
  assert.deepEqual(core.parseQuantity('10 штук'), { amount: 10, base: 'pcs' });
  assert.deepEqual(core.parseQuantity('кг'), { amount: 1000, base: 'g' });
  assert.deepEqual(core.parseQuantity('за кг'), { amount: 1000, base: 'g' });
});

test('parseQuantity: text without a pack size gives null', () => {
  for (const text of [null, undefined, '', '   ', '2,5%', '79.99 гривень', '1 лимон', 'Роздріб']) {
    assert.equal(core.parseQuantity(text), null, String(text));
  }
});

test('parseQuantity: finds the size in an aria-label but not in the price', () => {
  assert.deepEqual(
    core.parseQuantity(', 900г, стара ціна 79.99 гривень, знижка 19%, нова ціна 64.9 гривень'),
    { amount: 900, base: 'g' }
  );
  // the card on the milk page whose size field is empty
  assert.equal(core.parseQuantity('; ; 79.99 грн'), null);
});

test('parsePrice', () => {
  assert.equal(core.parsePrice(' 64.90 грн '), 64.9);
  assert.equal(core.parsePrice('48,90грн'), 48.9);
  assert.equal(core.parsePrice('1 299.00 грн'), 1299);
  assert.equal(core.parsePrice('1\u00a0299,50 грн'), 1299.5);
  // v3 removed all spaces first and read this as 64.9079
  assert.equal(core.parsePrice('64.90 грн 79.99 грн'), 64.9);
  assert.equal(core.parsePrice('грн'), null);
  assert.equal(core.parsePrice('0.00 грн'), null);
  assert.equal(core.parsePrice(null), null);
});

test('unitPrice: per 100 g / 100 ml / 1 piece', () => {
  const up = core.unitPrice(64.9, { amount: 900, base: 'g' });
  assert.equal(up.per, 100);
  assert.equal(up.base, 'g');
  assert.ok(Math.abs(up.value - 7.2111) < 1e-3);

  assert.deepEqual(core.unitPrice(59.9, { amount: 10, base: 'pcs' }), {
    value: 5.99,
    per: 1,
    base: 'pcs',
  });
  assert.equal(core.perLabel(core.unitPrice(109, { amount: 1500, base: 'ml' })), '100 мл');
  assert.equal(core.perLabel(core.unitPrice(59.9, { amount: 10, base: 'pcs' })), 'шт');
});

test('unitPrice: nothing to show for a single piece or missing data', () => {
  assert.equal(core.unitPrice(45, { amount: 1, base: 'pcs' }), null);
  assert.equal(core.unitPrice(null, { amount: 900, base: 'g' }), null);
  assert.equal(core.unitPrice(64.9, null), null);
  assert.equal(core.unitPrice(64.9, { amount: 0, base: 'g' }), null);
});

test('createRanker: ranks split a group into thirds', () => {
  assert.deepEqual(tally([1, 2, 3, 4, 5, 6, 7, 8, 9]), { best: 3, average: 3, worst: 3 });
  // sizes that are not a multiple of 3 stay balanced, the extra goes to the middle
  assert.deepEqual(tally([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { best: 3, average: 4, worst: 3 });
  assert.deepEqual(tally([1, 2, 3, 4]), { best: 1, average: 2, worst: 1 });
  assert.deepEqual(tally([1, 2, 3]), { best: 1, average: 1, worst: 1 });
});

test('createRanker: outliers do not squash the scale (real milk page)', () => {
  // v3 used (value - min) / (max - min): 41 of these 45 were green.
  assert.deepEqual(tally(MILK_PAGE), { best: 15, average: 15, worst: 15 });
});

test('createRanker: equal prices share a tier', () => {
  const rank = core.createRanker([5, 5, 7, 9, 9]);
  assert.equal(rank(5).tier, rank(5).tier);
  assert.equal(rank(9).tier, 'worst');
});

test('createRanker: neutral when there is nothing to compare', () => {
  assert.deepEqual(core.createRanker([7.27])(7.27), {
    tier: 'neutral',
    reason: 'few',
    n: 1,
    median: 7.27,
  });
  assert.equal(core.createRanker([5, 5, 5, 5])(5).reason, 'same');
  // v3 divided by a zero range here and painted everything red
  assert.equal(core.createRanker([5, 5, 5, 5])(5).tier, 'neutral');
});

test('createRanker: "cheaper than" percentage', () => {
  const rank = core.createRanker([1, 2, 3, 4, 5]);
  assert.equal(rank(1).cheaperThanPct, 100);
  assert.equal(rank(3).cheaperThanPct, 50);
  assert.equal(rank(5).cheaperThanPct, 0);
  assert.equal(rank(3).median, 3);
});
