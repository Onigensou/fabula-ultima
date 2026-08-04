#!/usr/bin/env bash
# Pre-push guard: every LevelDB store's CURRENT must name a MANIFEST-* that is
# actually PRESENT in the given tree. A dangling pointer makes the store fail to
# open on a clean pull even though no .ldb is missing (co-dev, 2026-07-20).
# Usage: check-manifests.sh <tree-ish>      e.g. HEAD, or a `git write-tree` sha
set -u
TREE="${1:-HEAD}"
WORLD="worlds/fabula-ultima-2"
ok=0; bad=0
for store in $(git ls-tree -r --name-only "$TREE" -- "$WORLD/data" "$WORLD/packs" \
               | grep '/CURRENT$' | sed 's|/CURRENT$||' | sort -u); do
  cur=$(git show "$TREE:$store/CURRENT" 2>/dev/null | tr -d '\r\n')
  if [ -z "$cur" ]; then
    echo "  ✗ $store — CURRENT unreadable in tree"; bad=$((bad+1)); continue
  fi
  if git cat-file -e "$TREE:$store/$cur" 2>/dev/null; then
    ok=$((ok+1))
  else
    echo "  ✗ $store — CURRENT -> $cur MISSING from tree"; bad=$((bad+1))
  fi
done
echo "manifests present: $ok/$((ok+bad))"
[ "$bad" -eq 0 ] || { echo "DO NOT PUSH — $bad dangling store(s)"; exit 1; }
echo "healthy"
