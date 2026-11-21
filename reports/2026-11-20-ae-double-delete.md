# Crisis "ActiveEffect … does not exist!" toast fixed (v1.0.635)

A heal that lifts a creature out of Crisis could show a red "ActiveEffect "<id>" does not exist!" toast. Seen in a Nox Legion sim when Keren's Life Transference healed her out of Crisis.

Code only. No world data, no migration, no new `module.json` entries (a hard reload is enough).

## Cause
Two pieces of code remove Crisis when HP rises above the threshold, and both ran in the same frame on the GM client:
- `battle-director/crisis-reactor.js` (the battle's settle step), and
- `battle-director/derived-status-reactor.js` (the safety net on `updateActor`).

Both saw Crisis still on and both asked the server to delete it. The first worked; the second got "does not exist!". Only one client is involved, so this is not the multi-client race behind the old "Token does not exist" toast.

## Fix
- New `scripts/shared/ae-delete-once.js`: `deleteEffectsOnce(actor, ids)` skips ids that are already gone or that another caller is deleting right now, and waits for that delete to finish so the caller sees the committed state. Real server errors still reach the caller that owns the delete.
- crisis-reactor (both deletes) and derived-status (`_reconcileOnce`) use it.
- Crisis still comes off once; the "leaves Crisis" announcement and reactions are unchanged.
- The other places that delete effects are untouched. Use the helper if another one shows the same toast.

## Tests
- `scripts/shared/ae-delete-once.test.mjs`: 11/11.
- Staging World: healing a creature out of Crisis while both writers run threw the error on main; with the fix, 0 errors in 42 trials and Crisis cleared every time.

## Owed
- A real-table look at a heal that lifts someone out of Crisis.
