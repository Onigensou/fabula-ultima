/**
 * Visible Token Picker — Foundry V12
 * ---------------------------------------------------------------------------
 * Small dialog for "choose a creature you can see" prompts. First consumer:
 * Heart of Darkness (Phase G) — apply_ae uses this to let the reactor pick
 * the target of a newly-created Bond.
 *
 * Scope: a thin Dialog that lists candidate tokens on the active scene,
 * minus the reactor, hidden tokens, and any name-excluded targets.
 *
 * Open question: visibility currently means "not hidden by GM." True
 * line-of-sight ("creature you can see" per RAW) would need
 * canvas.effects.visibility.testVisibility() per candidate — defer until a
 * skill author asks for it.
 *
 * API: globalThis["oni.VisibleTokenPicker"].pickVisibleToken(opts)
 *   opts.reactorToken       Token | TokenDocument | null   — excluded from list
 *   opts.excludeNames       string[]                       — case-insensitive
 *                                                            actor/token names
 *                                                            to filter out
 *   opts.title              string?                        — Dialog title
 *   opts.prompt             string?                        — Body heading
 *
 * Returns: Promise<{
 *   ok: boolean,
 *   cancelled?: boolean,
 *   reason?: string,
 *   tokenUuid?: string,
 *   actorUuid?: string,
 *   tokenName?: string,
 *   actorName?: string
 * }>
 */
(() => {
  const TAG = "[VisibleTokenPicker]";
  const KEY = "oni.VisibleTokenPicker";

  if (globalThis[KEY]) return;

  const esc = (s) => String(s ?? "").replace(/[<>&"']/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;"
  })[c]);

  function _norm(v) { return String(v ?? "").trim().toLowerCase(); }

  function _reactorTokenId(reactorToken) {
    return reactorToken?.id ?? reactorToken?.document?.id ?? reactorToken?._id ?? null;
  }


  // A creature declaring `cannot_be_targeted_by: "any"` can never be chosen — the
  // shared targeting contract (canonical reader: hasUnconditionalTargetBlock in
  // battle-director/snapshot.js; not imported, the reaction system stays
  // independent of the director). This picker asks the human to "choose a
  // creature you can see", which is a TARGET choice like any other.
  function _isUntargetable(a) {
    const effects = a?.effects?.contents ?? a?.effects ?? [];
    for (const ae of effects) {
      if (ae?.disabled) continue;
      for (const ch of (ae?.changes ?? [])) {
        if (ch?.key !== "cannot_be_targeted_by") continue;
        if (String(ch.value ?? "").trim().toLowerCase().split(/[\s,]+/).includes("any")) return true;
      }
    }
    return false;
  }

  function _collectCandidates({ reactorToken, excludeNames }) {
    const scene = canvas?.scene;
    if (!scene) return [];

    const excludeSet = new Set(excludeNames.map(_norm).filter(Boolean));
    const reactorId = _reactorTokenId(reactorToken);

    const placeables = canvas?.tokens?.placeables ?? [];
    const out = [];
    for (const tok of placeables) {
      const doc = tok?.document ?? tok;
      if (!doc) continue;
      if (doc.id === reactorId) continue;
      if (doc.hidden) continue;

      const actor = doc.actor ?? tok.actor ?? null;
      if (_isUntargetable(actor)) continue;
      const tokenName = String(doc.name ?? tok.name ?? "").trim();
      const actorName = String(actor?.name ?? "").trim();
      if (!tokenName && !actorName) continue;

      const nameLower = _norm(tokenName);
      const actorLower = _norm(actorName);
      if ((nameLower && excludeSet.has(nameLower)) ||
          (actorLower && excludeSet.has(actorLower))) continue;

      out.push({
        tokenUuid: doc.uuid ?? null,
        actorUuid: actor?.uuid ?? null,
        tokenName,
        actorName,
        img: doc.texture?.src ?? actor?.img ?? null
      });
    }

    return out;
  }

  function _renderContent(prompt, candidates) {
    const promptLine = prompt ? `<p>${esc(prompt)}</p>` : "";
    const rows = candidates.map((c, i) => {
      const label = c.actorName && c.actorName !== c.tokenName
        ? `${esc(c.actorName)} <span style="opacity:.6">(${esc(c.tokenName)})</span>`
        : esc(c.tokenName || c.actorName);
      const img = c.img
        ? `<img src="${esc(c.img)}" style="width:32px;height:32px;border:0;flex:none;border-radius:3px;">`
        : `<div style="width:32px;height:32px;flex:none;"></div>`;
      return `
        <div class="oni-vtp-row" data-idx="${i}"
             style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:4px;">
          ${img}
          <div>${label}</div>
        </div>`;
    }).join("");

    return `
      <div class="oni-vtp-wrap" style="display:flex;flex-direction:column;gap:6px;min-width:280px;">
        ${promptLine}
        <div class="oni-vtp-list" style="display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto;">
          ${rows || `<p><em>No eligible targets.</em></p>`}
        </div>
      </div>`;
  }

  async function pickVisibleToken(opts = {}) {
    const {
      reactorToken = null,
      excludeNames = [],
      title = "Choose a Target",
      prompt = "Choose a creature you can see."
    } = opts;

    const candidates = _collectCandidates({ reactorToken, excludeNames: excludeNames ?? [] });
    if (!candidates.length) {
      return { ok: false, reason: "no_candidates" };
    }

    return new Promise((resolve) => {
      let resolved = false;
      const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };

      const dlg = new Dialog({
        title,
        content: _renderContent(prompt, candidates),
        buttons: {
          cancel: { label: "Cancel", callback: () => done({ ok: false, cancelled: true }) }
        },
        default: "cancel",
        close: () => done({ ok: false, cancelled: true }),
        render: (html) => {
          const $html = html instanceof jQuery ? html : $(html);
          $html.find(".oni-vtp-row").css({ "border": "1px solid transparent" });
          $html.find(".oni-vtp-row")
            .on("mouseenter", function () { $(this).css("background", "rgba(255,255,255,.08)"); })
            .on("mouseleave", function () { $(this).css("background", "transparent"); })
            .on("click", function () {
              const i = Number(this.dataset.idx);
              const c = candidates[i];
              if (!c) return;
              try { dlg.close({ force: true }); } catch (_) {}
              done({
                ok: true,
                tokenUuid: c.tokenUuid,
                actorUuid: c.actorUuid,
                tokenName: c.tokenName,
                actorName: c.actorName
              });
            });
        }
      }, { width: 360 });

      dlg.render(true);
    });
  }

  globalThis[KEY] = {
    pickVisibleToken,
    _collectCandidates // exposed for unit/dry-run testing
  };

  console.debug(TAG, "registered");
})();
