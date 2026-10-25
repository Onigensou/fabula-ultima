// scripts/linked-text/lt-boot.js
// Linked item text — boot. Registers the tag enricher, wires the peek/panel
// cards, decorates links on Foundry-rendered surfaces (item/actor sheets,
// journals, chat), and publishes the API.
//
// API (also on globalThis.FULinkedText, available before `ready`, so IIFE
// scripts can call it without importing):
//   renderLinkedText(html) → html     tags + @UUID → links, all links restyled
//   plainLinkedText(html)  → html     tags + @UUID → their labels (summaries)
//   decorateLinks(root)    → count    restyle links in rendered DOM
//   resolveUuid(uuid, label) / resolveTag(tag, ref, label) → term | null
//   openCard({ uuid, label, rect }) / closeCard()

import { renderLinkedText, plainLinkedText, decorateLinks, registerEnricher, linkHTML, safeHtml } from "./lt-render.js";
import { resolveUuid, resolveTag } from "./lt-terms.js";
import { initCards, openCard, closeCard } from "./lt-card.js";
import { convertHtml, convertWorld, restoreBackup, runLinkedTextLint, minimalLink } from "./lt-convert.js";

const api = Object.freeze({
  renderLinkedText, plainLinkedText, decorateLinks, linkHTML, safeHtml,
  resolveUuid, resolveTag, openCard, closeCard,
  // Storage format + cleanup (GM tools):
  convertHtml, convertWorld, restoreBackup, minimalLink,
});
globalThis.FULinkedText = api;

Hooks.once("init", () => registerEnricher());

Hooks.once("ready", () => {
  initCards();
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.linkedText = api;
  globalThis.FUCompanion.api.lint ??= {};
  globalThis.FUCompanion.api.lint.runLinkedTextLint = runLinkedTextLint;
});

// Sheets are a developer-side data container now, but they should still read
// the same as the in-game UI. Chat carries "Link in chat" posts.
const decorate = (_app, html) => {
  const el = html?.[0] ?? html;
  try { decorateLinks(el); } catch (e) { console.warn("[FU LinkedText] decorate failed", e); }
};
Hooks.on("renderItemSheet", decorate);
Hooks.on("renderActorSheet", decorate);
Hooks.on("renderJournalPageSheet", decorate);
Hooks.on("renderChatMessage", (_msg, html) => decorate(null, html));
