// scripts/battle-director/keyword-suggest.js
// GM-only smart-suggestion for ProseMirror rich-text editors.
//
// As the GM types in any Foundry ProseMirror editor (CSB description fields use
// HTMLProseMirrorElement, so this covers item/actor/skill descriptions, journal
// pages, AE descriptions, etc.), a dropdown appears at the caret offering
// matching Action Keywords / Statuses from `keyword-registry.js`. Accepting one
// inserts a content-link to that term's JournalEntry — which the Action Card
// then renders as a styled keyword/status term.
//
// Integration: the supported V12 hook `createProseMirrorEditor(uuid, plugins,
// options)` lets us inject one ProseMirror plugin into every editor Foundry
// builds. The plugin's `view()` lifecycle gives us the live EditorView (caret
// coords via `coordsAtPos`, insertion via transactions) without DOM spelunking.
//
// Coexistence with ActiveEffectManager-key-suggestions.js (the AE key dropdown):
// different hook (renderActiveEffectConfig) + different surface (plain <input>
// change-key fields), so they never bind the same element. Focus is singular,
// so two dropdowns can't be open at once; on show we also proactively close the
// AE dropdown, and our dismiss logic is scoped to our own element.
//
// Trigger: live word-match, PREFIX-only (default) — the dropdown only appears
// when the trailing 1–2 typed words are a prefix of a registry term name, so it
// stays silent on ordinary prose.

import { log, warn } from "./logger.js";
import { searchTerms } from "./keyword-registry.js";

const DROPDOWN_CLASS = "fu-kw-suggest-dropdown";
const STYLE_ID = "fu-kw-suggest-style";
const DROPDOWN_W = 280;

let _installed = false;
let _enabled = true;
let _plugin = null;

// Per-EditorView → SuggestView, so the shared plugin's keydown prop can find the
// right instance. WeakMap so destroyed editors don't leak.
const VIEWS = new WeakMap();

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

// ── Styles ────────────────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .${DROPDOWN_CLASS} {
      position: fixed; z-index: 10000000; display: none;
      min-width: ${DROPDOWN_W}px; max-width: 360px; max-height: 300px;
      overflow-y: auto; overscroll-behavior: contain;
      padding: 4px; border-radius: 9px;
      border: 1px solid rgba(40,32,24,.34);
      background: rgba(248,242,224,.98);
      box-shadow: 0 12px 30px rgba(0,0,0,.30);
      color: #1f1a14;
      font-family: var(--font-primary,"Signika"),sans-serif;
    }
    .${DROPDOWN_CLASS} .fu-kw-suggest-head {
      padding: 4px 6px 5px; font-size: 10px; font-weight: 900;
      text-transform: uppercase; letter-spacing: .05em; opacity: .55;
    }
    .${DROPDOWN_CLASS} .fu-kw-suggest-row {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 7px; border-radius: 6px; cursor: pointer;
    }
    .${DROPDOWN_CLASS} .fu-kw-suggest-row:hover,
    .${DROPDOWN_CLASS} .fu-kw-suggest-row.active { background: rgba(65,50,32,.14); }
    .${DROPDOWN_CLASS} .fu-kw-suggest-icon {
      width: 18px; height: 18px; object-fit: contain; flex-shrink: 0;
      border: none; background: transparent; box-shadow: none; border-radius: 0;
    }
    .${DROPDOWN_CLASS} .fu-kw-suggest-name {
      font-weight: 800; font-size: 13px; flex: 1;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .${DROPDOWN_CLASS} .fu-kw-suggest-kind {
      font-size: 9px; font-weight: 800; text-transform: uppercase;
      letter-spacing: .03em; padding: 1px 6px; border-radius: 8px; flex-shrink: 0;
    }
    .${DROPDOWN_CLASS} .fu-kw-suggest-kind.is-keyword { background: rgba(201,138,42,.22); color: #7a4e12; }
    .${DROPDOWN_CLASS} .fu-kw-suggest-kind.is-status  { background: rgba(154,59,143,.18); color: #6e1f66; }
  `;
  document.head.appendChild(s);
}

// ── Insertion ─────────────────────────────────────────────────────────────────

// Replace [from,to) with a content-link to the term's JournalEntry. Primary:
// parse the same enriched anchor Foundry stores/round-trips, so it renders as a
// styled link immediately. Fallback: insert `@UUID[…]{Label}` text (always
// persists; enriches on display).
function insertContentLink(view, from, to, entry) {
  const id = String(entry.key).split(".").pop();
  try {
    const div = document.createElement("div");
    const a = document.createElement("a");
    a.className = "content-link";
    a.setAttribute("data-uuid", entry.key);
    a.setAttribute("data-id", id);
    a.setAttribute("data-type", "JournalEntry");
    a.setAttribute("data-tooltip", "Journal Entry");
    a.textContent = entry.label;
    div.appendChild(a);
    div.appendChild(document.createTextNode(" "));
    const parser = ProseMirror.DOMParser.fromSchema(view.state.schema);
    const slice = parser.parseSlice(div);
    view.dispatch(view.state.tr.replaceRange(from, to, slice).scrollIntoView());
  } catch (e) {
    warn("keyword-suggest: slice insert failed — falling back to @UUID text", e);
    const text = `@UUID[${entry.key}]{${entry.label}} `;
    view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
  }
}

// ── Per-editor suggestion controller ──────────────────────────────────────────

class SuggestView {
  constructor(view) {
    this.view = view;
    this.dropdown = null;
    this.rows = [];
    this.index = 0;
    this.range = null;
    VIEWS.set(view, this);
    this._onBlur = () => this.hide();
    try { view.dom.addEventListener("blur", this._onBlur, true); } catch {}
    this.update(view);
  }

  // ProseMirror plugin-view lifecycle: fires after every state update.
  update(view) {
    if (!_enabled) return this.hide();
    const sel = view.state.selection;
    if (!sel.empty) return this.hide();
    let focused = true;
    try { focused = view.hasFocus(); } catch {}
    if (!focused) return this.hide();

    const $from = sel.$from;
    if (!$from.parent || !$from.parent.isTextblock) return this.hide();
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", " ");
    // Trailing run of 1+ words that ENDS on a letter (cursor mid/end of a word).
    // Requiring a letter at the end means a completed word followed by a space —
    // e.g. the just-accepted "Unleash " — no longer matches, so accepting closes
    // the dropdown instead of re-opening on the finished word.
    const m = before.match(/([A-Za-z]+(?: [A-Za-z]+)*)$/);
    if (!m) return this.hide();

    const words = m[1].trim().split(/\s+/).filter(Boolean);
    // Try the last two words (for "Ice Shield", "Mana Burn"), then the last word.
    const cands = [];
    if (words.length >= 2) cands.push(words.slice(-2).join(" "));
    if (words.length >= 1) cands.push(words[words.length - 1]);

    let query = null, results = [];
    for (const c of cands) {
      if (c && c.length >= 2) {
        const r = searchTerms(c, { prefixOnly: true, limit: 8 });
        if (r.length) { query = c; results = r; break; }
      }
    }
    if (!query) return this.hide();

    this.rows = results;
    this.index = 0;
    this.range = { from: sel.from - query.length, to: sel.from };
    this.show(sel.from);
  }

  show(caretPos) {
    // Single visible dropdown across the two suggestion systems.
    try { globalThis.FUCompanion?.api?.activeEffectKeySuggestions?.hideDropdown?.(); } catch {}
    ensureStyles();
    if (!this.dropdown) {
      const dd = document.createElement("div");
      dd.className = DROPDOWN_CLASS;
      document.body.appendChild(dd);
      // mousedown (not click) + preventDefault so the editor keeps focus/selection.
      dd.addEventListener("mousedown", (ev) => {
        const row = ev.target.closest?.("[data-fu-kw-idx]");
        if (!row) return;
        ev.preventDefault(); ev.stopPropagation();
        this.accept(Number(row.dataset.fuKwIdx) || 0);
      });
      dd.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: true });
      this.dropdown = dd;
    }
    this.render();

    let coords = null;
    try { coords = this.view.coordsAtPos(caretPos); } catch {}
    if (!coords) return this.hide();
    const dd = this.dropdown;
    dd.style.display = "block";
    const left = Math.min(Math.max(6, coords.left), window.innerWidth - DROPDOWN_W - 10);
    dd.style.left = `${Math.round(left)}px`;
    dd.style.top = `${Math.round(coords.bottom + 4)}px`;
  }

  render() {
    const dd = this.dropdown;
    if (!dd) return;
    dd.innerHTML = `<div class="fu-kw-suggest-head">Keyword / Status</div>` +
      this.rows.map((r, i) => {
        const iconSafe = r.icon && !/['"<>\n\r]/.test(String(r.icon)) ? String(r.icon) : null;
        const icon = iconSafe
          ? `<img class="fu-kw-suggest-icon" src="${esc(iconSafe)}" alt="">`
          : `<span class="fu-kw-suggest-icon"></span>`;
        const kindCls = r.kind === "keyword" ? "is-keyword" : "is-status";
        const kindLabel = r.kind === "keyword" ? "Keyword" : "Status";
        return `<div class="fu-kw-suggest-row ${i === this.index ? "active" : ""}" data-fu-kw-idx="${i}">`
          + `${icon}<span class="fu-kw-suggest-name">${esc(r.label)}</span>`
          + `<span class="fu-kw-suggest-kind ${kindCls}">${kindLabel}</span></div>`;
      }).join("");
  }

  move(dir) {
    if (!this.rows.length) return;
    this.index = (this.index + dir + this.rows.length) % this.rows.length;
    this.render();
    this.dropdown?.querySelector(".fu-kw-suggest-row.active")?.scrollIntoView?.({ block: "nearest" });
  }

  accept(index = this.index) {
    const entry = this.rows[index];
    const range = this.range;
    this.hide();
    if (!entry || !range) return;
    insertContentLink(this.view, range.from, range.to, entry);
    try { this.view.focus(); } catch {}
  }

  isOpen() { return !!this.dropdown && this.dropdown.style.display === "block"; }

  // Returns true when it consumed the key (so the editor ignores it).
  handleKeyDown(event) {
    if (!this.isOpen()) return false;
    switch (event.key) {
      case "ArrowDown": this.move(1); return true;
      case "ArrowUp":   this.move(-1); return true;
      case "Enter":
      case "Tab":       this.accept(); return true;
      case "Escape":    this.hide(); return true;
      default:          return false;
    }
  }

  hide() {
    if (this.dropdown) { this.dropdown.style.display = "none"; this.dropdown.innerHTML = ""; }
    this.rows = []; this.index = 0; this.range = null;
  }

  destroy() {
    try { this.view.dom.removeEventListener("blur", this._onBlur, true); } catch {}
    if (this.dropdown) { try { this.dropdown.remove(); } catch {} this.dropdown = null; }
    try { VIEWS.delete(this.view); } catch {}
  }
}

// ── Plugin + hook ─────────────────────────────────────────────────────────────

function getPlugin() {
  if (_plugin) return _plugin;
  _plugin = new ProseMirror.Plugin({
    view: (editorView) => new SuggestView(editorView),
    props: {
      handleKeyDown(view, event) {
        const sv = VIEWS.get(view);
        return sv ? sv.handleKeyDown(event) : false;
      },
    },
  });
  return _plugin;
}

// Public, idempotent. Registers the editor hook once. GM-only at fire time.
export function initKeywordSuggest() {
  if (_installed) return;
  if (typeof ProseMirror === "undefined" || !ProseMirror?.Plugin) {
    warn("keyword-suggest: ProseMirror unavailable — smart-suggestion disabled");
    return;
  }
  Hooks.on("createProseMirrorEditor", (uuid, plugins) => {
    try {
      if (!_enabled || !game.user?.isGM || !plugins) return;
      plugins.fuKeywordSuggest = getPlugin();
    } catch (e) {
      warn("keyword-suggest: createProseMirrorEditor hook threw", e);
    }
  });

  // Light API for toggling (dev convenience).
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.keywordSuggest = {
    setEnabled: (v) => { _enabled = !!v; return _enabled; },
    isEnabled: () => _enabled,
  };

  _installed = true;
  log("keyword-suggest: installed (createProseMirrorEditor hook, GM-only)");
}
