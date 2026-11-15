# Fabula Arcana: match rules, card sort/search/filter, formations menu (v1.0.612)

Follow-up to `2026-11-15-fabula-arcana-affinity-feedback.md` (v1.0.611). Includes the formations work from the old `feat/fa-formations` branch (29a53cf1 + 7c114cb0, cherry-picked). **No card number changes.** No world data. NPC duels, practice, card drops and starter gifts behave exactly as before.

Files: `scripts/fabula-arcana/fa-engine.js` (+ tests), `fa-host.js`, `fa-entry.js`, `fa-client.js`, `fa-invite-ui.js`, `fa-boot.js`, `fa-const.js`, `assets/fabula-arcana/duel.html`, `tools/fabula-arcana-mockup/` (build + demo panel). Mockup: https://claude.ai/artifact/TPxjnLiPcs57dyEzEugaLX

## Why

The card pool is past 30, so team select needed sorting and search. The user also wanted PvP hosts to be able to pick a format, like Smogon/VGC tiers: no budget, only low-star cards, or "two ★ and one ★★".

## Match rules (PvP only; the challenger picks them)

| Rule | Options |
|---|---|
| Format | **Standard**: 5★ budget, the game as before (default). **Open**: no budget, any three cards. **Constellation**: the team must match a 3-slot star pattern; each slot is ★ / ★★ / ★★★ / Any, and the order doesn't matter. Presets: Commoner's Cup ★·★·★, Vanguard ★·★·★★, Elite Cup ★★×3, Boss Rush ★★★×3. |
| Mirror cards | Allowed (default) / Not allowed. Teams stay secret, so when both players are Ready and share a card, the host reveals **only the shared card**, strikes it from the match for both sides, un-readies both and shows "Card clash!". Both then pick again. |
| Character cards | Allowed (default) / Banned. |
| Series | Best of 1 / 3 / 5. In-game PvP was always Bo1 until now, because the camp button sent the challenge straight away. |

- **Engine:** `Engine.Format` holds `norm`, `fits`, `allowed`, `legalTeams`, `summary`, `why`, `CUPS`, `patText` and `cupName`. `isLegalTeam(ids, format?)` and `Match.create({ …, format })` take the rules, and the match state keeps them (`state.format`). When no format is passed, the rules are Standard, so every existing caller is unchanged. With mirror cards off, `Match.create` refuses two teams that share a card.
- **Host:** the session gets `format` and `clash`.
  - The challenge is refused before any invite if either character can't field a team under the rules. The challenger gets the reason, e.g. "Blanche can't field a team for Elite Cup: needs 3 × ★★."
  - A character with no playable cards is checked again after the starter gift on accept. If the gift still can't meet the rules, the duel is called off on both sides.
  - Ready, the suggested team and the ★ default formation all follow the rules and skip struck cards. Rematch keeps the rules and clears the clash list.
- **Camp challenge:** the button opens a setup panel (`showChallengeSetup` in `fa-invite-ui.js`) with the rules and Best of. It remembers the last choice (`localStorage` key `fa.challengeRules`, per browser). The invite panel shows a rules line.
- **API:** `openChallenge(actor)` is new (opens the panel). `challengePlayer(actor, { bestOf, format })` now takes `format`.

## Team select (duel window)

- **Sort:** Binder order, Stars, Element (chart order), Speed, ATK, HP, DEF, Role, Monster/Character, Name, with an ↑/↓ toggle. Stars, Element, Role and Type add section headers. The choice is kept per browser (`ccd.sort`).
- **Search:** matches name, ability and ability text, plus stat terms (`atk>3`, `spd>=4`, `hp=10`, `stars=2`). Press `/` to focus it.
- **Filters:** stars, element, role, Monsters/Characters, and "Fits my team". A count and a Clear link show when filters are on.
- **Team tray:** a 3-slot tray keeps the picks in view whatever the filter hides; click a slot to remove that card. In Constellation, each slot shows the star count it needs.
- **Locked cards say why:** Over budget, No ★★ slot left, Not in pattern, Banned, Clashed.
- **Rules:** read-only for both players in PvP ("Set by <challenger>"). Editable only on the standalone/mockup page.
- **Formations:** now a **Formations** drop-down button beside the title, showing the loaded deck's name. It has a **Name this deck** field (Enter saves), Save / + Save as new, and ✏ rename. Loading a deck closes the menu, as do Esc and a click outside. Keys 1–5 still work while it's closed. The `faTeams` flag format is unchanged.
- When you're Ready, you can still browse, but the pick, opener, tray and formation edits are locked.
- Standalone page only: it now also merges the module catalog, so character cards show in the mockup. In-game PvP already did this.

## Heads-up

- **Open and Constellation have no balance pass.** They're casual host options; the 45–55% targets are measured on Standard only. Three bosses in Open is expected to be swingy.
- NPC duelists stay Standard. `setDuelist` has no `format` option yet; it would be the hook for a tournament NPC later.
- If you call `isLegalTeam` / `LEGAL_TEAMS` yourself: `LEGAL_TEAMS` is still the Standard list.

## Tested

- `fa-engine.test.mjs`: all pass, including 16 new format checks.
- Standalone page / mockup (headless):
  - Search, sort, filters, each format, AI teams under the rules, clash, phone width: 21/21.
  - Formations menu: 10/10.
  - Challenge setup panel + invite rules line: 6/6.
- Staging World, in-game PvP (headless, canvas off; 2 players + GM): **19/19**.
  - Setup panel → invite shows the rules → host session holds them → read-only in both windows.
  - Illegal team refused by the host.
  - Clash: both un-readied, banner shown, card struck and refused again.
  - Named formation saved on the character.
  - Best of 3 under Vanguard starts; remembered rules; Open with three bosses starts.
  - A rule set the opponent can't field is refused with the reason and no invite.
  - Standard is still the default.
- Regression in Staging: Unready + spectator close 13/13; the polish run (PvP rematch, leave, NPC duel + rematch) clean. 0 page errors throughout.
- Not yet seen at the real table.
