# Asura Defeated cutscene + picture commands + message box (v1.0.627)

After the party beats Asura, a JRPG-style flashback cutscene plays: Asura praises the party, two full-screen illustrations show his past defeats (by a dragon shown only as "???", then by Fafnir), and the GM then picks how he leaves. The user approved it after a playable mockup and a sandbox playthrough. It is built from Event rows. The new pieces it needed are general rows and options that any event can use.

World data: **one scene only**, Abandoned Monastery Interior (`Valley_Map017`, `YnGINTK5qxtt0rnO`). The Victory and Defeat rows of both Asura Start Battle rows are replaced: the one in the entrance tile's "Fight" choice and the one in the talk-prompt token's. One hidden marker token, "Defeat Shot", is added. No actor or item changes. The two illustrations and three portraits are on Forge under `Campaign/The Legend of Dragonslayer/Image/CG/`.

## What happens in game

1. The battle ends and the victory fanfare plays. **The map is silent** when the party comes back, through the whole cutscene (new Start Battle option, below).
2. Letterbox in, and the camera frames the party and Asura. Asura: "Kuh....! Such splendid display…", "…defeated for the third time..!" Each line in a square JRPG message box with his portrait.
3. Fade to black and CG 1 comes up full screen: Asura fallen before a dragon's silhouette. The look is "Faded memory" (light sepia, dark edges), with a slow push-in, thunder and the Darkness ambience. Three "???" lines play in a see-through box over the picture. The picture darkens and fades out.
4. CG 2: Asura before Fafnir in dragon form, with the Fafnir / Asura exchange (12 lines).
5. Back to the present. Asura: "GRRR...! DAMN IT ALL!…" (shout box).
6. **Free narration**: the event pauses with a GM panel ("roleplay freely, then pick how it ends") and three choices:
   - **Swayed: accepts defeat**: three lines, a dust cloud at half speed, Asura gone.
   - **Enraged: vows revenge**: shouts, a flash and shockwave, dust, Asura gone.
   - **Neutral: withdraws**: two lines, then he leaps out of view.
7. Letterbox out and the event ends. The scene's storm ambience comes back.

If the party **loses**, the Defeat rows are a single Free narration pause with a "Continue" button.

## New and changed rows (all optional; old rows behave as before)

| Row | Change |
|---|---|
| **Show Picture** (new) | Slot 1-20, a higher slot draws on top. Fields: file (image or webm), fit (fill / whole / own size), x/y %, scale, opacity, rotation, blend (normal / add / multiply), fade-in seconds, tint preset, dark edges, film grain, "keep after the event", wait. Showing into a used slot crossfades. |
| **Move Picture** (new) | Slot. Changes any of x / y / scale / opacity / rotation (blank keeps the current value) over a duration with an easing. Movement is transform-only, so slow push-ins don't jitter. |
| **Tint Picture** (new) | Slot or all. Presets: normal, memory ("Faded memory"), gray, night, dark, or custom. Dark edges and grain, over a duration. |
| **Erase Picture** (new) | Slot or all, with an optional fade. |
| Show Text | **Show as**: Auto (message box when the speaker has no token on the scene, otherwise the bubble), Over the speaker, or Message box. **Box portrait** (a file, or none) and **Box look** (parchment, see-through over pictures, or auto). Shout and think also work in the box. Old rows stay "Over the speaker"; only new rows start on Auto. |
| Start Battle | **After victory: no music until the event ends** (`quietReturn`). |
| Play Animation | **Speed** (0.25-4×) for video playback; the GM's wait is scaled to match. |
| Set Token | **Picture**: keep / change picture / restore picture. The original is stored in the token flag `poseOriginal`, and facing is locked while posed. Not used by this cutscene. |

### Pictures, details
- **Layering:** pictures draw above the map and tokens, under Screen Effect fades and flashes, under the letterbox, and under dialogue.
- **GM view:** the GM sees pictures full screen, unlike other screen effects (user's decision).
- **Lifetime:** pictures end with their event unless kept, and are cleared when the scene is torn down.
- **Reload and late join:** a reloading or late-joining client asks a GM on the scene for the current pictures over the module socket (`ONI_EVENT_PICTURE_SYNC_REQ_V1` / `ONI_EVENT_PICTURE_SYNC_V1`). That state is held in GM memory only.
- **API:** `window.oni.EventSystem.Pictures` = `{ anyShown(), state(), … }`, and the hook `oniEventPicturesChanged`.

### Registry: `newRowData`
`normalizeRows` copies `defaultData` into every saved row it loads. So a new field whose default should apply only to *new* rows now goes in `newRowData` instead. `makeDefaultRow` applies it; normalize never does. Show Text uses it for `showAs: "auto"`.

## Fonts (user's decision)
- **Default:** Signika is the default in-game text font again (`--oni-text-font` in `styles/game-font.css`). This changes every text box that uses that variable. Pixelify Sans still ships with the module (`--oni-text-font-pixelify`).
- **Developer `font` option:** values are `"default"`, `"pixelify"` or any CSS font stack. It sets `--oni-text-font` on that element only and travels to every client. Accepted by:
  - `FU.Dialog.show`, `FU.Dialog.showFloating`
  - Show Text and Floating Text row data (no editor field)
  - `FU.SystemMessage.show`, `queue`, `broadcast`
- **Helpers:** `FU.DialogUI.resolveTextFont` / `applyTextFont`.

## Battle Director files touched (heads-up)
Both changes are additive and opt-in through payload `meta.quietReturn`, which is set only by an event Start Battle row with the new option:
- `battle-end/battle-end-orchestrator.js`: `endCtx.quietReturn` from `payload.meta.quietReturn`.
- `battle-end/battle-end-transition.js`: on a victory with quietReturn, Foundry's autoplay of the return scene's playlist is vetoed while the scene activates (`preUpdatePlaylistSound` / `preUpdatePlaylist` hooks on the activating client). A stop-all runs as a backstop. The event then resumes the scene's playlist sound after its Victory rows (also when the GM ends the event).

Measured on a real battle in the sandbox: fanfare, then silence under the black screen, then Storm2 when the event ends, with no autoplay blip (there was a 0.3 s blip before the veto).

## Tests
- 113 test files: 112 pass. The one failure, `battle-director/crisis-keywords.test.mjs` ("Hooks is not defined"), was failing before this work.
- New test files: `picture-rows.test.mjs` (61 checks), `message-box.test.mjs` (52).
- Extended: `media-extras.test.mjs` and `token-jump-extras.test.mjs`.
- The event linter is clean on the monastery scene.

## Not verified yet
- The party-loses path, live.
- A real player client: the box drawn without the speaker's token, a reload while a picture is up, and players never seeing hidden tokens.
- The Signika default across every text UI at a real table.
- The Pixelify font option in game.

## Art pipeline
The two illustrations were made with ChatGPT image generation, using the game sprites and the map as references, then shrunk to WebP at quality 82: 178 KB and 204 KB, from 2.5 MB PNGs. The user approved this as the workflow for future event CGs.
