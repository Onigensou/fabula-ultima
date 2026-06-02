# Fabula Ultima PDF → reference parser

Build `modules/fabula-ultima-companion/reference/skills.json` from
Fabula Ultima book PDFs.

The PDFs themselves are **not** in the repo (copyrighted ~150 MB).
The parser expects them on disk at `C:/Users/Nougat/Desktop/` —
adjust the `SRC` constant in each parser if your local path differs.

## Pipeline

```
PDFs (off-repo)
  └→ pdftotext -layout   (Poppler — bundled with Git for Windows)
       └→ e:/tmp/fu-pdf-text/*.txt
            └→ parse-<book>.js
                 └→ modules/.../reference/skills.json
```

## Run

```bash
# 1. Extract all PDFs to text once.
mkdir -p e:/tmp/fu-pdf-text/
cd "C:/Users/Nougat/Desktop/"
for pdf in Fabula*.pdf The_Low*.pdf; do
  out=$(echo "$pdf" | sed -E 's/[ ()]+/_/g; s/[,]+//g; s/_+$//; s/\.pdf$/.txt/i')
  "/c/Program Files/Git/mingw64/bin/pdftotext.exe" -layout "$pdf" "e:/tmp/fu-pdf-text/$out"
done

# 2. Run a parser.
node tools/parse-fu-pdfs/parse-core-skills.js

# 3. Output lands in modules/.../reference/skills.json (when configured).
#    For now, parse-core-skills.js writes to e:/tmp/fu-skills-core-base.json;
#    copy that into the reference dir manually until the in-place
#    write is wired up.
```

## Scripts

| Script | Status | Reads | Adds |
|---|---|---|---|
| `parse-core-skills.js` | shipped | Core PDF | `classes.<Class>.skills` (15 × 5 = 75) |
| `parse-core-heroic.js` | pending | Core PDF Ch. 4 heroic section | `classes.<Class>.heroic` + `universal_heroic` |
| `parse-core-spells.js` | pending | Core PDF per-class spell tables | `classes.<Class>.spells` |
| `parse-atlas.js` | pending | 4 Atlas PDFs | new classes + `universal_heroic` |
| `parse-bonus.js` | pending | 5 Bonus PDFs | mostly `universal_heroic` |
| `parse-playtest.js` | pending | Latest + older Playtest snapshots | `playtest_overrides` patches |

## Conventions

* Class names normalised to PascalCase on save (matches BD-tree
  folder names).
* Skill names normalised to Title Case (matches BD-tree master
  item names).
* `max_sl` extracted from `(◆N)` markers; absent = max SL 1.
* Description text is best-effort: PDF layout corrupts spacing,
  embeds page numbers mid-sentence, drops decorative chars. The
  cleanup pass restores common joins (`SL × 2extra` → `SL × 2 extra`,
  `DEX + WLPCheck` → `DEX + WLP Check`) but isn't exhaustive.

## When you find a parsing bug

1. Identify the affected skill + the raw PDF line.
2. Add a test-by-spot-check at the bottom of the parser.
3. Update the cleanup regex / boundary detector to fix.
4. Rerun, copy JSON over, commit both parser + JSON.

The parser is the source of truth; the JSON is the derived artifact.
