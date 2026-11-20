# Silpo Price Calculator

![CI](https://github.com/kyrylo-i-kovalenko/silpo-price-per-100g/actions/workflows/ci.yml/badge.svg)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)
![Permissions](https://img.shields.io/badge/permissions-none-success)

**English** | [Українська](README.uk.md)

A Chrome extension for [silpo.ua](https://silpo.ua), one of Ukraine's largest grocery chains. It shows the price per 100 g, 100 ml or 1 piece on every product card and highlights the best deals on the page.

## Features

- Calculates the price per 100 g, 100 ml or 1 piece for every product card. Kilograms, litres and multipacks such as 6×1.5 l are converted.
- Splits the products in a list into three equal tiers: "вигідно" (good deal), "середньо" (average), "дорого" (expensive). Each colour comes with a text label, so the tiers are readable for colour-blind users too.
- Shows multi-buy prices ("від 2 шт", from 2 pcs) on a separate line and ranks by the single-item price.
- The tooltip shows how the product compares to the median and how many products were compared.
- Works with "Показати ще" (Show more), filters, navigation between categories without a page reload, and prices updated in place.
- Needs no permissions, sends nothing and stores nothing.

## Installation

1. Download the zip from the latest [release](https://github.com/kyrylo-i-kovalenko/silpo-price-per-100g/releases) and unpack it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Open any product category on silpo.ua.

## How the colour is chosen

- **Comparison group:** products in the same list with the same unit. Grams are compared with grams, millilitres with millilitres, pieces with pieces.
- **Rank:** the cheapest third of the group is "good deal", the most expensive third is "expensive", the rest is "average". Equal prices always share a tier.
- **Grey "мало даних" (not enough data):** fewer than 3 products in the group, or all prices are equal. The tooltip explains which.

Why rank and not a min-max scale: on the milk page, a few flavoured drinks at 21–28 UAH/100 g turned 41 of 45 products green. With ranks the split is 15/15/15.

## How it was built

This is a vibe-coding project: an AI assistant wrote the code from my task descriptions, while I set the requirements, tested the result on the live site and decided what to change.

**Tools:** Claude

**Versions 1–3.** Basic price per 100 g/ml, then more reliable selectors, then colour highlighting.

**Version 4: a bug found in real use.** After scrolling, every badge turned grey. What was done together with the AI:

1. Saved the Silpo page and reproduced the bug in headless Chrome: 41 green and 4 red badges after loading, all 46 grey after the first scroll.
2. Found the cause: a global price array was cleared on every run, while cards that already had a badge were skipped before their price was added back. A re-run happened on every scroll because of one card whose pack size is missing on the site itself.
3. The investigation surfaced more issues: the multi-buy price was treated as the promo price, and outliers broke the colour scale.
4. Rewrote the logic so that nothing is kept between runs, added a regression test for this exact bug and verified the result on the live silpo.ua.

Full list of changes in [CHANGELOG.md](CHANGELOG.md) (in Ukrainian).

## Project structure

```
src/core.js      pure logic, no DOM: price and pack size parsing, unit price, ranking
src/content.js   page layer: reading cards, rendering badges, MutationObserver
src/styles.css   badge styles (spc- prefix, text contrast 6.5:1 and higher)
tests/           unit tests and DOM tests on real Silpo card markup (jsdom)
```

Key decisions:

- `scan()` recalculates everything from scratch and touches the DOM only when something actually changed, so repeated runs are safe and cannot loop.
- One debounced `MutationObserver` instead of a scroll listener and fixed delays.
- The first pass waits until Angular has hydrated the product cards (the `ngh` attributes are gone), so it never interferes with server-rendered markup.
- The pack size is read from the line under the product title, with the card's `aria-label` as a fallback.

## Development

```bash
npm install
npm test        # 24 tests: node:test + jsdom
npm run lint    # ESLint
npm run check   # both
```

For debugging, set `DEBUG = true` in `src/content.js`.

### Releasing

1. Bump `version` in `manifest.json` and `package.json`, and add a section for it to `CHANGELOG.md`.
2. Either push a matching tag (`git tag v4.0.0 && git push origin v4.0.0`), or on GitHub open **Releases > Draft a new release**, type the new tag (for example `v4.0.0`), leave the target as `main` and click **Publish release**.
3. The Release workflow checks the tag against the manifest, runs lint and tests, builds the zip and attaches it to the release. If the release has no description, the CHANGELOG section is used.

To build the zip locally: `npm run package` (writes `dist/silpo-price-calculator-<version>.zip`).

## Limitations

- Depends on the silpo.ua markup. If the site changes its card classes, update the selectors in the `SEL` object in `src/content.js`.
- Grams and millilitres are not compared with each other, since product densities differ.
- No per-piece price for single items: it equals the shelf price.
- Only products already loaded on the page are compared.

## License

MIT
