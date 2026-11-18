/**
 * Migration: 2026-11-18-botc-minion-free-setup  (Necromancer, Birth of the Cruel)
 * ---------------------------------------------------------------------------
 * Report: reports/2026-11-18-botc-minion-soldier-rules.md
 *
 * The engine now lets a reanimated Minion act once more in the same free action
 * after a skill tagged `minion_setup` (state-handlers.js, queueMinionSetupFollowUp).
 * This migration authors the data side:
 *
 *   1. Tag the setup skills (skill_tags token `minion_setup`). The tag is inert
 *      on the original monster — only a Minion performer reads it.
 *        Galvanic Paryashera — Steam Veil (Hidden → Spiral Drill)
 *      Every copy on an actor of that monster: the world actor, any
 *      "(Reanimated)" clone, and unlinked scene tokens.
 *   2. Birth of the Cruel's "Your Minion acts at the end of your turn" bullet
 *      gains one sentence saying so. Every copy of the skill.
 *
 * IDEMPOTENT: an existing tag or sentence is left alone.
 */

export const key = "2026-11-18-botc-minion-free-setup";
export const description =
  "Birth of the Cruel: tag Minion setup skills (Galvanic Paryashera's Steam Veil) with `minion_setup`, " +
  "and add the free-setup sentence to the skill text.";

const TAG = "minion_setup";
// monster name → skill names that are pure setups for its kit
const SETUPS = {
  "Galvanic Paryashera": ["Steam Veil"],
};

const SKILL_NAME = "Birth of the Cruel";
const ANCHOR = "chosen and driven automatically.";
const SENTENCE =
  " If that action only readies its next move (a stance, hiding, a charge), it acts " +
  "<strong>once more</strong> right after.";

export function addTag(raw) {
  const s = String(raw ?? "").trim();
  const toks = s ? s.split(/[\s,]+/).filter(Boolean) : [];
  if (toks.map((t) => t.toLowerCase()).includes(TAG)) return null;
  return [...toks, TAG].join(", ");
}

export function rewriteDescription(html) {
  const s = String(html ?? "");
  if (!s || s.includes("<strong>once more</strong> right after")) return null;
  const i = s.indexOf(ANCHOR);
  if (i < 0) return null;
  const at = i + ANCHOR.length;
  return s.slice(0, at) + SENTENCE + s.slice(at);
}

function setupNamesFor(actorName) {
  const base = String(actorName ?? "").replace(/\s*\(Reanimated\)\s*$/, "").trim();
  return SETUPS[base] ?? null;
}

async function tagActorItems(actor, where, log) {
  const names = setupNamesFor(actor?.name);
  if (!names) return 0;
  let n = 0;
  for (const it of actor.items?.contents ?? []) {
    if (!names.includes(String(it.name ?? "").trim())) continue;
    const next = addTag(it.system?.props?.skill_tags);
    if (next == null) continue;
    try { await it.update({ "system.props.skill_tags": next }); n += 1; log(`  ${where}: ${it.name} tagged`); }
    catch (e) { log(`  ${where}: ${it.name} failed — ${e?.message ?? e}`); }
  }
  return n;
}

async function fixSkillText(items, where, log) {
  let n = 0;
  for (const it of items ?? []) {
    if (String(it?.name ?? "").trim() !== SKILL_NAME) continue;
    const next = rewriteDescription(it.system?.props?.description);
    if (next == null) continue;
    try { await it.update({ "system.props.description": next }); n += 1; }
    catch (e) { log(`  ${where}: ${it.name} failed — ${e?.message ?? e}`); }
  }
  return n;
}

export async function migrate(game, log) {
  let tags = 0, texts = 0;
  texts += await fixSkillText(game.items?.contents ?? [], "world", log);
  for (const a of game.actors?.contents ?? []) {
    tags += await tagActorItems(a, a.name, log);
    texts += await fixSkillText(a.items?.contents ?? [], a.name, log);
  }
  for (const sc of game.scenes?.contents ?? []) {
    for (const t of sc.tokens?.contents ?? []) {
      if (t.actorLink || !t.actor) continue;
      tags += await tagActorItems(t.actor, `${sc.name}/${t.name}`, log);
      texts += await fixSkillText(t.actor.items?.contents ?? [], `${sc.name}/${t.name}`, log);
    }
  }
  return { applied: true, summary: `Minion free setup — ${tags} skill(s) tagged, ${texts} description(s)` };
}
