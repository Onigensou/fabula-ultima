// ═════════ move-engine · mockup RESULT PICKER (page UI; after the engine and shared/results.js)
// One row of chips every mockup page can show: which result the moves play, in the same shape the game hands them
// (shared/results.js). "Move's sliders" = each move's own tune. The picked result reaches moves through movePick().
//   mountResultPicker(parentElement)   (uses the page's .chips / .chip styles)
function mountResultPicker(parent) {
  if (!parent || document.getElementById("me-pick")) return null;
  window.MOVE_PICK = window.MOVE_PICK || { check: null, chain: null };
  const box = document.createElement("div"); box.id = "me-pick"; box.className = "opts";
  const row = (label, key, opts) => {
    const lab = document.createElement("div"); lab.className = "lbl"; lab.textContent = label;
    const chips = document.createElement("div"); chips.className = "chips";
    for (const [val, text] of opts) { const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = text;
      const sync = () => b.setAttribute("aria-pressed", String(window.MOVE_PICK[key] === val));
      b.onclick = () => { window.MOVE_PICK[key] = val; for (const c of chips.children) c.dispatchEvent(new Event("me-sync")); }; b.addEventListener("me-sync", sync); sync();
      chips.appendChild(b); }
    box.append(lab, chips);
  };
  row("Game result · one Accuracy Check", "check", [[null, "Move's sliders"], ["odd", "Hit · odd total"], ["even", "Hit · even total"], ["crit", "Critical"], ["miss", "Miss"], ["fumble", "Fumble"]]);
  row("Game result · Chain strikes", "chain", [[null, "Move's sliders"], ["all", "All land (Perfect)"], [0.75, "3 of 4 land"], [0.5, "Half land"], [0.25, "1 of 4 land"], [0, "None land"]]);
  const note = document.createElement("p"); note.className = "muted"; note.style.margin = "0";
  note.textContent = "In the game, the Battle Director hands the move this same result from the real roll.";
  box.appendChild(note);
  parent.appendChild(box);
  return box;
}
