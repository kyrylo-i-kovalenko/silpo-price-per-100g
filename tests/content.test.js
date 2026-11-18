'use strict';

// DOM tests: real Silpo card markup (tests/fixtures) + the content script,
// run inside jsdom. The first test is the regression test for the v3 bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const CORE = read('../src/core.js');
const CONTENT = read('../src/content.js');
const FIXTURE = read('fixtures/milk-category.html');

function load(html = FIXTURE) {
  const { window } = new JSDOM(html, { runScripts: 'outside-only' });
  window.eval(CORE);
  window.eval(CONTENT);
  return window;
}

const wait = (window, ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const cards = (w) => [...w.document.querySelectorAll('shop-silpo-common-product-card')];
const badgeOf = (card) => card.querySelector('.spc-badge');
const tierOf = (badge) => [...badge.classList].find((c) => c.startsWith('spc-badge--'));
const cardByTitle = (w, part) =>
  cards(w).find((c) => c.querySelector('.product-card__title').textContent.includes(part));
const snapshot = (w) =>
  cards(w).map((c) => {
    const b = badgeOf(c);
    return b ? `${b.querySelector('.spc-badge__amount').textContent} ${tierOf(b)}` : null;
  });

test('regression: colours survive repeated scans (v3 turned all badges grey)', () => {
  const w = load();
  w.SilpoPriceCalc.scan();
  const first = snapshot(w);
  w.SilpoPriceCalc.scan();
  w.SilpoPriceCalc.scan();
  assert.deepEqual(snapshot(w), first);
  // 10 gram products are ranked; only the single litre product stays neutral
  assert.equal(first.filter((s) => s && !s.endsWith('--neutral')).length, 10);
});

test('every card with a price and pack size gets exactly one badge', () => {
  const w = load();
  const result = { ...w.SilpoPriceCalc.scan() }; // copy out of the jsdom realm
  assert.deepEqual(result, { badges: 11, skipped: 1 });
  for (const card of cards(w)) {
    assert.ok(card.querySelectorAll('.spc-badge').length <= 1);
  }
  // the card whose size field is empty on silpo.ua
  assert.equal(badgeOf(cardByTitle(w, 'Ферма безлактозне')), null);
});

test('badge goes right after the title and reads correctly', () => {
  const w = load();
  w.SilpoPriceCalc.scan();
  const card = cardByTitle(w, 'Біла лінія');
  const badge = badgeOf(card);
  assert.equal(badge.previousElementSibling, card.querySelector('.product-card__title'));
  assert.equal(badge.querySelector('.spc-badge__amount').textContent, '7.21 грн');
  assert.equal(badge.querySelector('.spc-badge__unit').textContent, '/ 100 г');
  assert.match(badge.title, /Медіана: \d+\.\d\d грн/);
});

test('ranking uses the single-item price; the multi-buy price is shown separately', () => {
  const w = load();
  w.SilpoPriceCalc.scan();
  // 61.99 грн for one, 51.90 грн from 2 pcs, 900 г
  const badge = badgeOf(cardByTitle(w, 'Волошкове поле з вітаміном D3'));
  assert.equal(badge.querySelector('.spc-badge__amount').textContent, '6.89 грн');
  const offer = badge.querySelector('.spc-badge__offer');
  assert.equal(offer.hidden, false);
  assert.equal(offer.textContent, 'від 2 шт: 5.77 грн / 100 г');
});

test('kilograms and litres are converted; ml is not compared with g', () => {
  const w = load();
  w.SilpoPriceCalc.scan();
  const kg = badgeOf(cardByTitle(w, 'Волошкове поле ультрапастеризоване'));
  assert.equal(kg.querySelector('.spc-badge__amount').textContent, '6.80 грн');
  const litre = badgeOf(cardByTitle(w, 'Бурьонка» питне'));
  assert.equal(litre.querySelector('.spc-badge__unit').textContent, '/ 100 мл');
  assert.equal(tierOf(litre), 'spc-badge--neutral'); // the only ml product here
});

test('price changed in place by Angular: badge updates', async () => {
  const w = load();
  w.SilpoPriceCalc.scan();
  const card = cardByTitle(w, 'Біла лінія');
  card.querySelector('.product-card-price__displayPrice').firstChild.data = ' 18.00 грн ';
  await wait(w, 300);
  const badge = badgeOf(card);
  assert.equal(badge.querySelector('.spc-badge__amount').textContent, '2.00 грн');
  assert.equal(tierOf(badge), 'spc-badge--best');
});

test('badge removed by a re-render comes back', async () => {
  const w = load();
  w.SilpoPriceCalc.scan();
  const card = cardByTitle(w, 'Біла лінія');
  badgeOf(card).remove();
  // what Angular does when it re-renders: touch the card's own nodes
  card.querySelector('.product-card__title').after(w.document.createComment(''));
  await wait(w, 300);
  assert.ok(badgeOf(card));
});

test('"Показати ще": new cards get badges and everything is re-ranked', async () => {
  const w = load();
  w.SilpoPriceCalc.scan();
  const list = w.document.querySelector('.products-list');
  const extra = list.firstElementChild.cloneNode(true);
  extra.querySelector('.spc-badge').remove();
  extra.querySelector('.product-card-price__displayPrice').textContent = ' 30.00 грн ';
  list.append(extra);
  await wait(w, 300);
  const badge = badgeOf(extra.querySelector('shop-silpo-common-product-card'));
  assert.equal(badge.querySelector('.spc-badge__amount').textContent, '3.33 грн');
  assert.match(badge.title, /Найнижча ціна/);
  assert.equal(w.document.querySelectorAll('.spc-badge').length, 12);
});

test('our own DOM writes do not trigger endless rescans', async () => {
  const w = load();
  await wait(w, 400); // let the initial scheduled pass finish
  let mutations = 0;
  const observer = new w.MutationObserver((list) => (mutations += list.length));
  observer.observe(w.document.body, { childList: true, subtree: true, characterData: true });
  w.SilpoPriceCalc.scan();
  await wait(w, 400);
  assert.equal(mutations, 0, 'a pass with nothing new must not touch the DOM');
});

test('waits until server-rendered cards are hydrated', async () => {
  const html = FIXTURE.replace(
    '<shop-silpo-common-product-card>',
    '<shop-silpo-common-product-card ngh="19">'
  );
  const w = load(html);
  await wait(w, 400);
  assert.equal(w.document.querySelectorAll('.spc-badge').length, 0);
  w.document.querySelector('[ngh]').removeAttribute('ngh'); // what Angular does
  await wait(w, 600);
  assert.equal(w.document.querySelectorAll('.spc-badge').length, 11);
});

test('an SSR-only element outside the cards does not block the pass', async () => {
  // silpo.ua keeps ngh on <shop-silpo-ssr-menu> in the header forever
  const html = FIXTURE.replace('<body>', '<body><shop-silpo-ssr-menu ngh="10"></shop-silpo-ssr-menu>');
  const w = load(html);
  await wait(w, 400);
  assert.equal(w.document.querySelectorAll('.spc-badge').length, 11);
});
