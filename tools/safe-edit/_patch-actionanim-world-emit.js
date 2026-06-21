// Remove the redundant legacy `emit("world", { _oniTurnUI: ... })` lines from the
// ActionAnimationHandler macro. The correct module-channel emit already sits
// directly above each one, so this is subtractive only.
const { getDoc, safeEdit } = require("./lib");

const UUID = "Macro.8B43YmZv7b8wZEzJ";
// Matches both the live lines and the string-template copies; removes the whole line.
const LINE_RE = /^.*game\.socket\.emit\(\s*["']world["']\s*,\s*\{\s*_oniTurnUI:.*$\n?/gm;

(async () => {
  const doc = await getDoc(UUID);
  const before = doc.command;
  const removed = (before.match(LINE_RE) || []).length;
  const after = before.replace(LINE_RE, "");

  if (removed === 0) { console.log("No matching lines found — nothing to do."); return; }
  if (/\.emit\(\s*["']world["']/.test(after)) {
    console.log("WARNING: a 'world' emit still remains after patch — inspect manually.");
  }

  console.log(`Removing ${removed} legacy "world" emit line(s) from ${doc.name}.`);
  const r = await safeEdit({
    uuid: UUID,
    patch: { command: after },
    note: 'crash fix: drop legacy emit("world") turn-UI lines (module channel already used)',
  });
  console.log("Patched. Journal entry:", r.entryId);
})().catch(e => { console.error(e); process.exit(1); });
