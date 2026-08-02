---
id: 2026-08-02-howler-gone-cursor-sfx-dead
title: Activating main.js exposed a dead Howler dependency — the cursor SFX never caches
status: open
severity: cosmetic
reporter: onigensou
assignee: sarunphat
component: scripts/main.js
introduced_in: ef0650fb
fixed_in:
---

# `new Howl(...)` throws on every boot — Foundry dropped Howler in v10

Not a regression from your commit — `ef0650fb` is correct and does what it says.
But turning the file on for the first time made a pre-existing bug start
executing, so it belongs to that commit's blast radius.

## Symptom

`game.modules.get("fabula-ultima-companion").api.sfx.cursor` is never populated.
The speech-bubble types **silently** instead of beeping per character.

## Evidence

Probed live via the test-bridge on the post-pull boot (world `fabula-ultima-2`,
bootId `KtoZh0RHpzFPoudY`):

```json
{
  "foundryVersion": "12.343",
  "howlDefined":    false,
  "howlerDefined":  false,
  "howlConstructs": false,
  "howlError":      "Howl is not defined"
}
```

And the module-api probe from the same boot:

```json
{ "moduleActive": true, "hasSpeechBubbleApi": true,
  "hasCursorSfx": false, "chatBtnPresent": true }
```

So `main.js` parses and runs correctly now — `api.speechBubble` is registered,
the chat button injects — and only the SFX block fails.

## Root cause

`scripts/main.js:233` comments *"Foundry ships Howler. Create a single Howl
instance and reuse it."* That was true through v9; **Howler was removed in v10**
in favour of the native Web Audio API. On v12.343 the identifier does not exist,
so the constructor throws `ReferenceError` on every world load. The surrounding
`try/catch` swallows it into a `console.warn`, which is why it reads as silence
rather than a crash.

## Impact — cosmetic only, confirmed

`scripts/speech-bubble.js:54-60` guards the read:

```js
const howl = game.modules.get(MODULE_ID)?.api?.sfx?.cursor;
if (howl) { howl.volume(volume); howl.play(); return; }
// Fallback safety: do nothing if cache missing.
```

`if (howl)` is falsy, it returns, bubbles render fine without audio. Nothing
downstream breaks and no other consumer of `api.sfx.cursor` exists (grepped:
only `main.js:240` writes it, only `speech-bubble.js:56` reads it).

## Suggested fix

Either drop the block entirely, or port it to the v12 audio API — roughly
`foundry.audio.AudioHelper.play({ src: CURSOR_URL, volume: 0.55 }, false)` at
call time instead of caching a Howl at `ready`. Worth confirming the exact
namespace on your side; the point is that any Howler-shaped call is dead on v12.

Low priority — filing it so it is not rediscovered as a mystery later.

## Notes

- Also note `CURSOR_URL` points at `assets.forge-vtt.com`. Even once the audio
  call is fixed, that is a remote fetch on every world load.
