---
id: 2026-08-25-session-start-button-full-width
title: Start Session button renders 1920px wide and intercepts clicks on anything in the bottom strip
status: open
severity: major
reporter: onigensou
assignee: sarunphat
component: session-system/session-start-button
introduced_in: fd25a5bf
fixed_in:
---

# The Start Session control is a full-width bar, not a pill

Your comment says exactly what you wanted, and I agree with the placement reasoning:

> Mirrors battle-director/dev-tools-menu.js so the two controls sit side by side
> instead of on top of each other … Sitting to its RIGHT (the same offset its own
> `devToolsAnchorLeft` reports) keeps this clear of that stack.

`LEFT` computes to 74 (`session-start-button.js:45-46`), and the rest of the rule is
plainly written for a compact badge+label: `display:flex`, `gap:6px`,
`padding:6px 11px`, `border-radius:10px`. That is not what renders.

Measured live, GM client, 1920x1027, Foundry 12.343:

| property | value |
|---|---|
| computed `width` | **1920px** |
| `left` | 74px |
| right edge | **1995px** — 75px past the viewport |
| height | 42px |
| `margin` | `0px 1px` |
| `line-height` | `28px` |

## Root cause

`style.css:2140` in Foundry core is a **bare element selector**:

```css
button {
  width: 100%;
  margin: 0 1px;
  line-height: 28px;
  ...
}
```

`#fud-session-start-btn` is created as a real `<button>` and appended straight to
`document.body`:

```js
// session-start-button.js:238, :244
const btn = document.createElement("button");
document.body.appendChild(btn);
```

so it lives outside any Application window and the global applies. Your rule is
ID-scoped and therefore vastly more specific — but specificity cannot override a
property the rule never declares, and the block at `:267-284` sets no `width`
(confirmed: zero `width` declarations in it). `margin` and `line-height` leak in from
the same rule for the same reason.

This is not a specificity fight you lost. It is a property you never entered, so core
supplies it.

## The part that makes this more than cosmetic

`#fud-session-start-btn` is `z-index: 80`. The gacha overlay is `z-index: 60`, so the
bar paints on top of it — and being 1920px wide, it spans the full bottom strip of
every scene.

Measured on the Gacha Scene:

| | Wish x1 | Wish x10 |
|---|---|---|
| button rect | 1018,895 250x56 | 1284,895 250x56 |
| overlap with bar | **250x26** | **250x26** |
| `elementFromPoint` at button TOP | `fud-session-start-btn` | `fud-session-start-btn` |
| `elementFromPoint` at button CENTRE | `gu-wish` | `gu-wish` |

The top 26px of each 56px button — roughly the upper half — dispatches to Start Session
instead. And by your own note the action is deliberately not idempotent:

> It is deliberately not idempotent — pressing it twice applies twice — because a
> once-per-session guard needs a session boundary, which does not exist yet.

So a misclick aimed at Wish x1 opens the Start Session confirm, and an accepted confirm
applies Instability -1d6, Bodyguard Fatigue -1d6 and a Lucky Number reset across the
whole party, with no undo. Filed **major** rather than minor for that reason: the width
bug is cosmetic, but the click interception it creates is not, and it is not specific to
the gacha screen — anything that renders in the bottom 42px band under `z-index: 80` is
affected.

## Repro

1. Join as GM at 1920 wide.
2. `document.getElementById("fud-session-start-btn").getBoundingClientRect()` → width 1920, right 1995.
3. View any scene with UI in the bottom strip (the Gacha Scene is the clearest).
4. `document.elementFromPoint(<wish button centre x>, <its top + 4>)` → `fud-session-start-btn`.

## Suggested fix

One property in the `#${BTN_ID}` block, `session-start-button.js:267`:

```css
width: auto;        /* or fit-content */
```

`margin: 0` and `line-height: normal` are worth adding alongside if the 42px height or
the 1px side margin are not what you intended either — both are core's, not yours.

## Notes

- This trap has now bitten this repo four times. It is written up in
  `gacha-system/gacha-theme.js:73-89`, which neutralises it for the three gacha roots:

  ```css
  #gacha-ui button, #gacha-panel button, #gacha-fx button,
  #gacha-ui input, #gacha-panel input { width: auto; flex: 0 0 auto; line-height: normal; }
  ```

  The rule of thumb that came out of it: **any `<button>` appended to `document.body`
  rather than into an Application window inherits `width:100%` from core**, and the
  symptom is always a control that renders as a full-width bar. Worth a shared helper if
  a fifth root appears — happy to put one in if you'd rather not duplicate the block.
- Nothing else about the feature is implicated. `session_started` dispatch, the party
  resolution, the confirm dialog and the three quirk clauses all behave; the dialog is a
  `<div>` (`:156`) so it is correctly sized. This is purely the launcher's own box.
- I did not touch your file. Reported rather than patched because the fix is a
  presentation decision on a control you designed, and you may want the pill sized
  deliberately rather than left to `fit-content`.
