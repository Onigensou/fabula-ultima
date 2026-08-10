# Skill Reference — Schema

`skills.json` is the canonical reference for Fabula Ultima skill data
across **every book the campaign uses**: Core, Atlases, Bonus PDFs,
and the latest Playtest. The Battle Director consumes it for
RAW-drift lint; humans consume it for skill authoring.

Build process: `tools/parse-fu-pdfs/parse-*.js` ingests `pdftotext`
output and produces this file. PDFs themselves are **not** in the
repo (copyrighted, ~150 MB) — they live on the GM's machine.

## Top-level shape

```jsonc
{
  "_meta": { ... },           // generation provenance + phase tracker
  "classes": {
    "Rogue": {
      "book": "core",         // primary source book key
      "skills": [             // base class skills (5 per class in Core)
        { "name": "Cheap Shot", "max_sl": 5, "description": "...", "source": {...} },
        ...
      ],
      "heroic": [],           // class-bound heroic skills (some Atlases)
      "spells": [],            // class-bound spell list (Spiritist, Elementalist, etc.)

      // ── optional, present when the parser captured them ──
      "third_party": true,     // NOT a Need Games book — see `dark-fantasy`
      "also_known_as": [],     // the book's "ALSO:" alternate class names
      "blurb": "...",          // the class's flavour paragraph
      "character_questions": [],  // the 4 prompts in the class header box
      "free_benefits": [],     // "<CLASS> FREE BENEFITS" bullets, verbatim
      "player_advice": [],     // the book's "PLAYER ADVICE: <CLASS>" bullets
      "gm_advice": [],         // the book's "GM ADVICE: <CLASS>" bullets
      "raw_notes": { },        // "<field>[i]" -> note about a quirk kept verbatim
      "subsystems": { }        // named rules blocks a Skill depends on
    },
    ...
  },
  "universal_heroic": [],     // non-class-specific heroic skills (Adversity, Bimagus, ...)

  // Optional systems that grant Skills but are not Classes.
  "lineage_traditions": { },  // Dark Fantasy Lineages: Tradition -> { skills, ... }
  "lineage_system": { }       // the Lineage Turn / epilogue / allocation procedure
}
```

### `subsystems`

Some Skills are a one-line pointer at multi-page rules ("The full rules for
negotiation and recruitment can be found on the next page"). Storing only the
Skill text loses the mechanism, so those rules live in `classes.<Class>.
subsystems.<key>` and the Skill carries `"subsystem_ref": "<key>"`. Today:
`Tamer.subsystems.negotiation` (clock, attitude table, recruitment, using
recruited creatures).

## Per-skill shape

```jsonc
{
  "name": "Cheap Shot",          // Title Case
  "max_sl": 5,                    // RAW max Skill Level
  "skill_type": "Passive",        // Active | Passive | Spell | Ritual (Phase 2+)
  "description": "When you hit a creature with an attack, ...",
  "source": {
    "book": "core",               // sources.<key> from _meta
    "page": 203,                  // page number (when known)
    "section": "ROGUE SKILLS",    // chapter section header
    "line": 8181                  // line in the pdftotext output (debug)
  },
  "playtest_overrides": [         // present iff a playtest patched this skill
    {
      "date": "2026-02-08",
      "field": "max_sl",
      "from": 3,
      "to": 5,
      "source": "playtest-2026-02-08"
    }
  ],
  "playtest_variants": [          // optional alt-mechanic proposals NOT applied to top-level
    {
      "date": "2026-02-08",
      "source": "playtest-2026-02-08",
      "applied_to_canonical": false,
      "alternate_name": "Agile Defender",  // when the variant ships under a new skill name
      "summary": "What the variant changes (RAW text or paraphrase).",
      "project_note": "Authoring decision: keep base or split into separate skill."
    }
  ],
  "raw_note": "Flags a typo/oddity preserved verbatim from the book."
}
```

## Notation inside `description`

Book typography is normalised on ingest so descriptions stay plain text:

| In the book | Stored as | Why |
|---|---|---|
| `【SL × 2】` decorative brackets around a value | `SL × 2` | matches the Core entries |
| the orange lightning-bolt "offensive spell" glyph | `(⚡)` | `pdftotext` drops it entirely, leaving a bare `( )`; the marker is load-bearing (offensive spells require a Magic Check) |
| curly quotes / en-dashes | straight `'` `"` `-` | stable string matching |

Spells additionally carry the machine-readable `"is_offensive": true|false` —
prefer that over string-matching the glyph.

Multi-paragraph text is joined with `\n\n`, matching the book's paragraph
breaks. Book typos and sentences that overflow their text box are kept
**verbatim** and flagged in `raw_note` (per skill) or `raw_notes` (per class,
keyed `"<field>[index]"`) rather than silently corrected — e.g. Outcasts
*Leftovers* really does read "a potion that restores that restores".

⚠ Core entries predate this rule and still contain the raw extraction artifact
(`offensive (r) spell` in Entropist *Mirror*). Normalise them when Core is
next reparsed.

The merged shape (after layering playtest patches) reflects the
**latest authoritative state**. `playtest_overrides` is a history
trail — useful for design archaeology and diff PRs, ignored by the
lint rule.

`playtest_variants` is a parallel field for OPTIONAL alt-mechanic
proposals the playtest offers that should NOT be applied to the
canonical top-level shape. Common cases: a "BODYGUARD > AGILE
DEFENDER" rename (Feb 2026) where the variant lives under a new
skill name; a "we considered changing X but reverted" history note.
The top-level skill stays at its authoritative shape; the variant
is recorded for archaeology + future authoring decisions.

## Source keys (in `_meta.sources`)

| Key | Book | Phase |
|---|---|---|
| `core` | Fabula Ultima Core Rulebook | shipped |
| `atlas-hf` | High Fantasy Atlas | pending |
| `atlas-nf` | Natural Fantasy Atlas | pending |
| `atlas-tf` | Techno Fantasy Atlas | pending |
| `atlas-lf` | Low Fantasy Atlas | pending |
| `bonus-necromancer` | Fabula Ultima Bonus 01 — Necromancer | pending |
| `bonus-halloween-2023` | Fabula Bonus 04 — Halloween 2023 | pending |
| `bonus-halloween-2024` | Fabula Bonus 06 — Halloween 2024 | pending |
| `bonus-ace-of-cards` | Fabula Bonus — Ace of Cards | pending |
| `bonus-arcane-whispers` | Fabula Ultima Bonus 05 — Arcane Whispers | pending |
| `dark-fantasy` | Dark Fantasy Classes v0.2 — **third party** | shipped |
| `playtest-<date>` | Playtest Materials snapshot | pending — chronological patch layer |

### ⚠ `dark-fantasy` is not RAW

Aaron Jolliffe's *Dark Fantasy Classes* v0.2, published under the Fabula Ultima
Third-Party Tabletop License 1.0 — **not a Need Games book**, and still at v0.2.
It is the sole source for Hexer, Slayer and Tamer, all three of which are live
class templates in the world. Everything it contributes is flagged
`"third_party": true` at the class / tradition / source level. Treat its balance
as provisional and confirm intent with the user rather than citing it as RAW.

## Class name convention

PascalCase, matching the Battle Director folder tree
(`Battle Director / <Class> / <Skill | Spell | Heroic Skill>`). The
parser normalises the PDF's ALL-CAPS class headers to PascalCase on
save.

## Skill name convention

Title Case (`Cheap Shot`), matching the BD-tree master items. Old
playtest variants of a skill name (e.g. lowercase `See you later`)
are NOT recorded as separate entries — the latest canonical name
wins and player customisations are preserved on the live actor
copy (per the skill-swap protocol).

## Drift lint contract (planned — Phase 6)

`scripts/lint/skill-raw-drift-lint.js` will:
1. Walk BD-tree masters (`Battle Director / <Class> / ...`).
2. For each, look up `classes[<Class>].skills[<name>]` in this file.
3. Diff: `max_sl` (vs `system.props.max_level`), `name`, `isHeroic`.
4. Surface `RAW_MAX_SL_DRIFT`, `RAW_NAME_DRIFT` findings.

The lint will be info-level by default (RAW deviations are sometimes
intentional homebrew). Authors override with a `_homebrew: true` flag
on the BD master to silence specific drift.

## When to update

* **Adding a Playtest patch**: rerun `tools/parse-fu-pdfs/parse-playtest.js`
  pointing at the new dated PDF. The script appends override entries
  with `date` set to the playtest release date.
* **Adding an Atlas / Bonus**: rerun the relevant `parse-<book>.js`.
  Atlas skills land in `classes.<Class>.skills`; Bonus skills usually
  land in `universal_heroic` (campaign-flavor heroic skills).
* **Regenerating from a corrected parser**: rerun the relevant
  `parse-*.js` then commit the JSON. The parser scripts ARE the
  source of truth; the JSON is the derived artifact.

## Limits + known gaps

Measured 2026-08-10 against the file as it stands (34 classes / 170 class
skills). Ordered by how much damage the gap can do to an authoring session.

1. **Heroic skills are a catalogue, not RAW — 135 of 137 have no
   `description`, only a one-line `brief`** ("Arcana help you influence
   Clocks."). Authoring a heroic skill from this file means authoring from a
   summary. `parse-core-heroic.js` / `parse-atlas-heroic.js` scraped the
   LIST tables, never the detail sections.
2. **Ten heroic `name`s are corrupted by the same scrape** — two adjacent
   skills fused (`Pulverizing Strike Rising Tide`, `Silent Hunter
   Weaponmaster`, `Spider's Web Swirling Swarm`, `Tabula Rasa Theme Song`,
   `Greater Akromorphosis Greater Ecdysis`), a page number glued on
   (`Mimeoclepsis 170`), or a name truncated (`Strength of`). A name lookup
   against these silently misses.
3. **The June 22nd 2026 playtest is not ingested.** `_meta.sources` stops at
   `playtest-2026-02-08`, and only 3 skills (Guardian's Bodyguard / Fortress
   / Rampart) carry any playtest field at all. `parse-playtest.js` still
   does not exist; patches are added by hand as skills are touched.
4. **Three books have never been ingested**: Halloween 2023 (monster
   Quirks), Halloween 2024 (heroic skills), Arcane Whispers (sample Arcana
   with Dismiss effects). Arcanist therefore has an empty `spells` array and
   no Arcanum list anywhere.
5. **Spell lists cover 4 classes** (Elementalist 12, Entropist 11, Spiritist
   12, Hexer 12). Symbolist symbols, Invoker invocations, Floralist
   magisphere effects, Tinkerer gadgets, Mutant therioforms and Gourmet
   recipes are all sub-lists this file does not model. Chimerist's empty
   list is correct — RAW gives it no fixed spell list.
6. **`skill_type` is populated for 15 of 170 class skills** — the
   `dark-fantasy` ones only. The Core/Atlas books use iconography that
   `pdftotext` drops, so the rest needs a curated mapping table.
7. **`source.page` is empty everywhere except `dark-fantasy`**, and the
   Core/Atlas `source.line` values point at extraction line numbers that no
   longer reproduce.
8. Class-level context (`free_benefits`, `blurb`, `also_known_as`,
   `character_questions`) exists for 3 of 34 classes — `dark-fantasy` only.
9. Core/Atlas descriptions still carry extraction artifacts (stray page
   numbers mid-sentence, missing spaces around `×`, the `(r)` glyph relic).
   Acceptable for lint; not clean enough to render as in-game tooltips.

### Not a gap in this file

Nine skills on the live Hexer / Slayer / Tamer templates have **no source in
any ingested book** and are not in Dark Fantasy v0.2: Hexer *Contagion*,
*Abyss*, *Lethal Dosage*; Slayer *Protective Strike*, *Weak Point*,
*Harvester*; Tamer *Expanded Party*, *Rapid Hybridization*, *Elite
Recruitment*. Three per class, in the shape of class-bound heroic skills —
almost certainly campaign homebrew. Do not "restore" them from a book; ask.
