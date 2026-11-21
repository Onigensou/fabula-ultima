# Numbered keyword chips on the action card (v1.0.646)

## What was wrong

On the action card's Effect panel, a keyword with a number (Chain 2, Multi 3)
lost its number. The keyword link moved up into the chip row, but the number is
authored *after* the link (`<a>Chain</a><strong>&nbsp;2</strong><strong>&nbsp;Pick</strong>`),
so it stayed behind as an orphan bullet: **• 2 Pick**.

## What changed

The number now joins the chip, card-game style: **◆ CHAIN 2**, **◆ MULTI 3**.

- **Value-only bullet** — when the keyword's bullet/paragraph holds nothing but
  a number (plus an optional Pick / Random / Seek and a comma or period), the
  number goes into the chip and the bullet disappears. The mode word is dropped;
  the subtitle already shows "Chain ×2 (Pick)".
- **Lead-in sentence** — "Chain 3: call down three bolts…" becomes a CHAIN 3
  chip and the prose reads "Call down three bolts…".
- Link text authored as "Multi (2)" now reads "Multi 2", same as the rest.
- Keywords in the middle of a sentence are left exactly as before.

Treasure Roulette's equip panel uses the same parser, so it gets this too.

Code: new `scripts/battle-director/keyword-value.js`, 7 lines in
`action-card.js` (`parseEffectDescription`). No world data, no migration.

## Checked

Headless Chromium against every world description carrying a Multi or Chain
link (99): no stray numbers left; chips come out Multi 2/3/4, Chain 2/3/6/12.
Not yet seen at a real table.

## Known leftover (not changed)

A keyword used mid-sentence ("this attack gains Multi 3, its damage type
becomes Dark") is still lifted out of the prose, leaving "gains  3,". This was
already the case before; about 6 item descriptions.

## For you

Pull and reload the page. Nothing else to do.
