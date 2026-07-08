# Anim Studio

Tooling for authoring Battle Director `animation_script` cinematics. Two halves:

- **In-game** (module: `scripts/anim-studio/*`, plus the `oni` helper library
  and the BD preview core): a scene-control **Preview Bench**, an **SFX
  Browser**, and the `oni` inner-script helpers.
- **Disk CLI** (this folder): encode/validate/push/pull animation scripts via
  the live test-bridge, and a starter template library.

Zero npm dependencies — pure Node fs. Requires Node ≥ 18.

## Everyday flow

```
# 1. Scaffold from a template
node bin/anim-studio.js new projectile --out fireball-anim.js

# 2. Edit the CFG block + inner script. Validate offline (compile + storage
#    round-trip + backtick/String.raw guards):
node bin/anim-studio.js verify fireball-anim.js

# 3. Push it LIVE to an item's animation_script (game running + bridge active),
#    with an automatic browser round-trip re-check:
node bin/anim-studio.js push fireball-anim.js --uuid Actor.xxxx.Item.yyyy

# 4. See it without combat: in Foundry, open the Anim Studio scene-control
#    button → Preview Bench → pick the item → Run. Tweak the CFG box, Run again.
```

Pull an existing animation back to disk to edit it:

```
node bin/anim-studio.js pull --uuid Actor.xxxx.Item.yyyy --out existing-anim.js
```

Rebuild the SFX manifest (walks your Forge `Sound/` tree in-game and mirrors
the manifest into the repo):

```
node bin/anim-studio.js sfx-sync
```

## Commands

| command | what |
|---|---|
| `list-templates` | list starter templates |
| `new <tpl> [--out F]` | scaffold a script from a template |
| `verify <file>` | offline validate (compile + lossless storage round-trip + backtick/String.raw rules) |
| `encode <file> [--out F]` | print/write the HTML-escaped stored form |
| `decode <file> [--out F]` | reverse encode (stored HTML → plain JS) |
| `push <file> --uuid U` | validate → encode → write LIVE → browser round-trip verify |
| `pull --uuid U [--out F]` | read an item's animation_script LIVE → decode → file |
| `sfx-sync` | trigger the in-game Forge SFX scan; report count |
| `health` | test-bridge liveness |

LIVE commands (`push`/`pull`/`sfx-sync`) need the game running with a GM logged
in and the bridge active: `FUCompanion.api.testBridge.activate()`.

## The two storage gotchas (why `verify` exists)

1. **HTML rich-text field.** `animation_script` is a ProseMirror field; BD's
   `_stripHtml` eats raw `<` / `>` / `=>`. We store HTML-escaped + `<p>`-wrapped;
   `verify` proves the encode→decode round-trip is lossless.
2. **String.raw inner template.** A stray backtick *anywhere* (even a comment)
   closes the inner template early. `verify` enforces exactly 2 backticks and
   none inside the inner, and compiles the inner the way the pseudo listener
   runs it.

## Templates

Starter templates use the two-layer structure (GM outer broadcasts an inner
`scriptSource` to every client) with the inner written against the **`oni`**
helper library, so each is short and skips the hand-rolled recipes:

- `projectile` — glowing bolt caster→target, impact flash + screenshake.
- `webm-target` — optional white pre-flash, play a `.webm` at target/caster.
- `self-buff` — warm glow + rising embers on the caster (no target).

The `oni` helpers available inside the inner script: `screen()` (screen-lock
transforms), `layer()`, `cloneToken()`, `hideToken()`, `tween()`/`EASE`,
`gradientTexture()`/`radialTexture()`, `webmSprite()`, `whiteout()`/`dim()`/
`screenshake()`, `sfx()`/`sfxUrl()`, `fireDone()`, `wait`. Everything is
auto-disposed after the inner script's async IIFE resolves.
