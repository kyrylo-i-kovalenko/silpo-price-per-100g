/**
 * Silpo Price Calculator: DOM layer (content script).
 *
 * - `scan()` is one stateless pass: read every product card, compute its unit
 *   price, rank each comparison group from scratch and update the badges.
 *   It writes to the DOM only when something actually changed, so it is safe
 *   to run as often as needed.
 * - A debounced MutationObserver runs `scan()` whenever cards appear,
 *   disappear or change: infinite scroll, "Показати ще", filters, SPA
 *   navigation, prices updated in place. No scroll listener, no fixed delays.
 *
 * Why stateless: v3 kept a global price list that was cleared on every run,
 * while cards that already had a badge were skipped before their price was
 * added back. After the first re-run (any scroll) the list was empty and
 * every badge turned grey. Nothing is carried between passes here.
 */
(() => {
  'use strict';

  const Core = globalThis.SilpoPriceCore;
  if (!Core || globalThis.SilpoPriceCalc) return; // core not loaded, or already running

  const VERSION = '4.0.0';
  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.debug('[silpo-price]', ...args);
  };

  globalThis.SilpoPriceCalc = { version: VERSION, scan };

  const SEL = {
    card: 'shop-silpo-common-product-card',
    body: '.product-card__body',
    title: '.product-card__title',
    price: '.product-card-price__displayPrice',
    offerPrice: '.product-card-offer__price',
    offerQty: '.product-card-offer__value',
    ariaLink: 'a.product-card__link[aria-label]',
    list: 'silpo-products-list, .products-list',
    // utility-class path used by v3; kept only as a fallback
    legacySize: '.ft-flex.ft-justify-between.ft-items-center.ft-mt-8 span',
  };

  const BADGE = 'spc-badge';
  const TIERS = ['best', 'average', 'worst', 'neutral'];
  const TIER_LABEL = {
    best: 'вигідно',
    average: 'середньо',
    worst: 'дорого',
    neutral: 'мало даних',
  };
  const UNIT_IN = { g: 'грамах', ml: 'мілілітрах', pcs: 'штуках' };

  const DEBOUNCE_MS = 150;
  const MAX_WAIT_MS = 1000;
  const HYDRATION_POLL_MS = 250;
  const HYDRATION_TIMEOUT_MS = 15000;

  // ----------------------------------------------------------------- reading

  const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  /** The pack size line is the first element after the title: "900г". */
  function readSizeText(body) {
    let el = body.querySelector(SEL.title);
    el = el && el.nextElementSibling;
    while (el && el.classList.contains(BADGE)) el = el.nextElementSibling;
    return textOf(el && el.querySelector('span')) || textOf(body.querySelector(SEL.legacySize));
  }

  /** Fallback source: the image link's aria-label, "Назва; 900г; 64.90 грн". */
  function readSizeFromAria(card, title) {
    const label = card.querySelector(SEL.ariaLink)?.getAttribute('aria-label') || '';
    return title && label.startsWith(title) ? label.slice(title.length) : label;
  }

  /**
   * Reads one product card.
   * @returns {null | {body: Element, unit: object, offer: object|null}}
   *   null when the card has no usable price or pack size.
   */
  function readCard(card) {
    const body = card.querySelector(SEL.body);
    if (!body) return null;

    // Current shelf price for one item. Discounts are already applied here;
    // the crossed-out price lives in a separate element.
    const price = Core.parsePrice(textOf(body.querySelector(SEL.price)));
    if (!price) return null;

    const title = textOf(body.querySelector(SEL.title));
    const quantity =
      Core.parseQuantity(readSizeText(body)) ||
      Core.parseQuantity(readSizeFromAria(card, title));
    const unit = Core.unitPrice(price, quantity);
    if (!unit) return null;

    // Multi-buy price ("51.90 грн, від 2 шт"). v3 treated it as the promo
    // price; it only applies from N items, so it is shown as extra info and
    // the ranking uses the single-item price.
    let offer = null;
    const offerPrice = Core.parsePrice(textOf(body.querySelector(SEL.offerPrice)));
    if (offerPrice && offerPrice < price) {
      offer = {
        label: textOf(body.querySelector(SEL.offerQty)) || 'за акцією',
        unit: Core.unitPrice(offerPrice, quantity),
      };
    }
    return { body, unit, offer };
  }

  // --------------------------------------------------------------- rendering

  const lastView = new WeakMap(); // badge element -> rendered view signature

  function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function createBadge() {
    const badge = el('div', BADGE);
    const row = el('div', `${BADGE}__row`);
    const price = el('span', `${BADGE}__price`);
    price.append(el('b', `${BADGE}__amount`), ' ', el('span', `${BADGE}__unit`));
    row.append(price, el('span', `${BADGE}__tier`));
    const offer = el('div', `${BADGE}__offer`);
    offer.hidden = true;
    badge.append(row, offer);
    return badge;
  }

  /** Tooltip text: what the colour means for this product. */
  function describe(item, verdict) {
    const money = Core.formatMoney;
    const per = Core.perLabel(item.unit);
    const lines = [`${money(item.unit.value)} грн за ${per}.`];

    if (verdict.tier === 'neutral') {
      lines.push(
        verdict.reason === 'same'
          ? `Усі товари в списку (${verdict.n}) мають однакову ціну за ${per}.`
          : `Для порівняння потрібно щонайменше 3 товари з ціною в ${UNIT_IN[item.unit.base]}, у списку: ${verdict.n}.`
      );
    } else {
      const pct = verdict.cheaperThanPct;
      lines.push(
        pct === 100
          ? 'Найнижча ціна за одиницю в списку.'
          : pct === 0
            ? 'Найвища ціна за одиницю в списку.'
            : `Дешевше, ніж ${pct}% інших товарів у списку.`
      );
      const diff = Math.round((item.unit.value / verdict.median - 1) * 100);
      const vsMedian =
        diff === 0
          ? 'на рівні медіани'
          : diff < 0
            ? `на ${-diff}% дешевше за медіану`
            : `на ${diff}% дорожче за медіану`;
      lines.push(
        `Медіана: ${money(verdict.median)} грн, ${vsMedian}. Порівнювалось товарів: ${verdict.n}.`
      );
    }

    if (item.offer && item.offer.unit) {
      lines.push(`Ціна ${item.offer.label}: ${money(item.offer.unit.value)} грн за ${per}.`);
    }
    return lines.join('\n');
  }

  function renderBadge(item, verdict) {
    const { body, unit, offer } = item;
    let badge = body.querySelector(`.${BADGE}`);
    if (!badge) badge = createBadge();

    // Keep the badge right after the title, even if Angular re-rendered
    // part of the card and left it somewhere else.
    const title = body.querySelector(SEL.title);
    if (title) {
      if (badge.previousElementSibling !== title) title.after(badge);
    } else if (!badge.isConnected) {
      body.prepend(badge);
    }

    const per = Core.perLabel(unit);
    const view = {
      tier: verdict.tier,
      amount: `${Core.formatMoney(unit.value)} грн`,
      unit: `/ ${per}`,
      tierLabel: TIER_LABEL[verdict.tier],
      offer:
        offer && offer.unit
          ? `${offer.label}: ${Core.formatMoney(offer.unit.value)} грн / ${per}`
          : '',
      tooltip: describe(item, verdict),
    };
    const signature = JSON.stringify(view);
    if (lastView.get(badge) === signature) return; // nothing changed
    lastView.set(badge, signature);

    for (const t of TIERS) badge.classList.toggle(`${BADGE}--${t}`, t === view.tier);
    badge.querySelector(`.${BADGE}__amount`).textContent = view.amount;
    badge.querySelector(`.${BADGE}__unit`).textContent = view.unit;
    badge.querySelector(`.${BADGE}__tier`).textContent = view.tierLabel;
    const offerEl = badge.querySelector(`.${BADGE}__offer`);
    offerEl.textContent = view.offer;
    offerEl.hidden = !view.offer;
    badge.title = view.tooltip;
  }

  // -------------------------------------------------------------------- scan

  /**
   * One full pass over the page. Groups are "same product list + same base
   * unit" (grams are never compared with millilitres or pieces).
   * @returns {{badges: number, skipped: number}}
   */
  function scan(root = document) {
    const groups = new Map(); // list element -> Map(base unit -> items)
    let skipped = 0;

    for (const card of root.querySelectorAll(SEL.card)) {
      const item = readCard(card);
      if (!item) {
        card.querySelector(`.${BADGE}`)?.remove(); // e.g. the price disappeared
        skipped++;
        continue;
      }
      const list = card.closest(SEL.list) || root;
      if (!groups.has(list)) groups.set(list, new Map());
      const byUnit = groups.get(list);
      if (!byUnit.has(item.unit.base)) byUnit.set(item.unit.base, []);
      byUnit.get(item.unit.base).push(item);
    }

    let badges = 0;
    for (const byUnit of groups.values()) {
      for (const items of byUnit.values()) {
        const rank = Core.createRanker(items.map((item) => item.unit.value));
        for (const item of items) {
          renderBadge(item, rank(item.unit.value));
          badges++;
        }
      }
    }
    log(`scan: ${badges} badges, ${skipped} cards without price or pack size`);
    return { badges, skipped };
  }

  // -------------------------------------------------------------- scheduling

  const startedAt = Date.now();
  let timer = 0;
  let pendingSince = 0;

  /** Debounced, with a max wait so a busy page cannot postpone it forever. */
  function requestScan() {
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    clearTimeout(timer);
    timer = setTimeout(runScan, now - pendingSince >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS);
  }

  // Server-rendered cards carry Angular `ngh` hydration attributes, removed
  // once the card is hydrated. Inserting nodes before that can confuse
  // hydration, so the pass waits (up to HYDRATION_TIMEOUT_MS). Only cards are
  // checked: an SSR-only menu in the header keeps its `ngh` for good.
  function isHydrating() {
    return (
      Date.now() - startedAt < HYDRATION_TIMEOUT_MS &&
      document.querySelector(`${SEL.card}[ngh], ${SEL.card} [ngh]`) !== null
    );
  }

  function runScan() {
    if (isHydrating()) {
      timer = setTimeout(runScan, HYDRATION_POLL_MS);
      return;
    }
    timer = 0;
    pendingSince = 0;
    try {
      scan();
    } catch (err) {
      console.error('[silpo-price] scan failed:', err);
    }
  }

  // --------------------------------------------------------------- observing

  const isBadge = (node) => node.nodeType === Node.ELEMENT_NODE && node.classList.contains(BADGE);
  const elementOf = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  const containsCard = (node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    (node.matches(SEL.card) || node.querySelector(SEL.card) !== null);

  function isRelevant(mutation) {
    const target = elementOf(mutation.target);
    if (!target || target.closest(`.${BADGE}`)) return false; // our own updates

    if (mutation.type === 'characterData') return target.closest(SEL.card) !== null;

    const nodes = [...mutation.addedNodes, ...mutation.removedNodes].filter((n) => !isBadge(n));
    if (nodes.length === 0) return false;
    if (target.closest(SEL.card)) return true; // something changed inside a card
    return nodes.some(containsCard); // cards added or removed
  }

  new MutationObserver((mutations) => {
    if (mutations.some(isRelevant)) requestScan();
  }).observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  requestScan();
  log(`v${VERSION} loaded`);
})();
