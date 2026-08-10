# Fabula Ultima PDF → reference parser

Build `modules/fabula-ultima-companion/reference/skills.json` from
Fabula Ultima book PDFs.

The PDFs live at **`reference/fabula-pdfs/`** (in the repo tree but
**gitignored** — they are the publisher's copyrighted books, ~97 MB).
Moved there from `C:/Users/Nougat/Desktop/` on 2026-08-10; see that
directory's `INDEX.md` for which book defines which class.

The parsers themselves read the **extracted text**, not the PDFs, so they
were unaffected by the move — only step 1 below changed.

## Pipeline

```
PDFs (reference/fabula-pdfs/, gitignored)
  └→ pdftotext -layout   (Poppler — bundled with Git for Windows)
       └→ e:/tmp/fu-pdf-text/*.txt
            └→ parse-<book>.js
                 └→ modules/.../reference/skills.json
```

## Run

```bash
# 1. Extract all PDFs to text once.
mkdir -p e:/tmp/fu-pdf-text/
cd reference/fabula-pdfs/
for pdf in Fabula*.pdf The_Low*.pdf Dark_Fantasy*.pdf; do
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
| `parse-dark-fantasy.js` | shipped | Dark Fantasy Classes v0.2 | Hexer / Slayer / Tamer + Hexer spells + `lineage_traditions` |
| `parse-playtest.js` | **missing** | Latest + older Playtest snapshots | `playtest_overrides` patches |

⚠ `parse-playtest.js` has never been written — the June 22nd 2026 playtest
(the only authoritative one) is **not** in `skills.json`. Patches are added by
hand as skills are touched.

### `parse-dark-fantasy.js` is curated, not scraped

The other parsers scrape `-layout` output. That book is a two-column zine whose
spell table is printed as two side-by-side tables, so one `-layout` line carries
text from both columns — and its "offensive spell" marker is a lightning-bolt
glyph with no ToUnicode mapping, which `pdftotext` drops entirely (leaving
`offensive ( )`). Every offensive flag was read off a 3× page render
(`pymupdf`), not inferred from wording.

To keep curation honest the script **re-verifies all 115 stored passages verbatim
against a fresh `pdftotext -enc UTF-8` extraction on every run** and exits
non-zero on drift:

```bash
node tools/parse-fu-pdfs/parse-dark-fantasy.js --dry-run   # verify + report, no write
node tools/parse-fu-pdfs/parse-dark-fantasy.js             # verify + write (idempotent)
node tools/parse-fu-pdfs/parse-dark-fantasy.js --txt x.txt # verify against a given extraction
```

It writes `skills.json` in place, preserving the file's CRLF style, and is the
only parser that does so — the others still emit to a temp file (step 3 below).

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
