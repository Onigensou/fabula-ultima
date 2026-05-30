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
      "spells": []             // class-bound spell list (Spiritist, Elementalist, etc.)
    },
    ...
  },
  "universal_heroic": []      // non-class-specific heroic skills (Adversity, Bimagus, ...)
}
```

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
      "to": 5
    }
  ]
}
```

The merged shape (after layering playtest patches) reflects the
**latest authoritative state**. `playtest_overrides` is a history
trail — useful for design archaeology and diff PRs, ignored by the
lint rule.

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
| `playtest-<date>` | Playtest Materials snapshot | pending — chronological patch layer |

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

* `skill_type` is not yet extracted (the Core book uses iconography
  rather than a textual marker). Phase 2 will add it via a curated
  mapping table.
* Descriptions contain occasional PDF-extraction artifacts (stray
  page numbers embedded mid-sentence, missing spaces around
  multiplication signs). Acceptable for lint use; not stable enough
  to render as in-game tooltips. Refine on demand.
* Class-specific spell lists (Spiritist, Elementalist, etc.) aren't
  extracted yet — Phase 2.
