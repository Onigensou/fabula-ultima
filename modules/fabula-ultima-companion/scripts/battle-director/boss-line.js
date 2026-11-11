// Boss line — a monster speaks before its signature move, once per playthrough.
//
// JRPG convention: the boss says its line in a speech box, THEN the move's
// name banner, THEN the attack. Only the first time; later casts go straight
// to the name and the attack.
//
// Author it on the skill item as a flag:
//
//   flags.fabula-ultima-companion.bossLine = {
//     text:    "Feel my battle prowess!",   // System Message markup allowed ({w:…})
//     switch:  "Asura Battle Line",         // event switch that remembers "said it"
//     speaker: "Asura",                     // optional — defaults to the caster's name
//     hold:    2200,                        // optional ms the line stays up
//   }
//
// "Once" is an ordinary event switch (event-gameState.js): it lives on the
// current party's database sheet, so a save/load puts it back to what the save
// held, a new party starts without it, and a GM can turn it off by hand on the
// sheet's switch table. No switch name = the line plays on every cast.
//
// Called from CONFIRM (GM side) before the action namecard. Never blocks the
// battle for long: the wait is capped, and any failure just skips the line.

const NS = "fabula-ultima-companion";
const FLAG = "bossLine";
const MAX_WAIT_MS = 9000;

// Lines already spoken this page load when no party database is available to
// hold the switch (a bare test world) — still once, just not saved.
const spokenThisLoad = new Set();

// Pure: the line config from an item (or its flags), or null when it has none.
export function readBossLine(item) {
  const raw = item?.flags?.[NS]?.[FLAG] ?? item?.getFlag?.(NS, FLAG);
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.text ?? "").trim();
  if (!text) return null;
  const hold = Number(raw.hold);
  return {
    text,
    speaker: String(raw.speaker ?? "").trim() || null,
    switchName: String(raw.switch ?? "").trim() || null,
    hold: hold > 0 ? hold : null,
  };
}

// Pure: the System Message payload for a line.
export function bossLineMessage(line, fallbackSpeaker = "") {
  const msg = { kind: "speech", speaker: line.speaker || fallbackSpeaker || "", text: line.text };
  if (line.hold) msg.hold = line.hold;
  return msg;
}

function gameState() {
  return globalThis.oni?.GameState ?? globalThis.oni?.EventSystem?.GameState ?? null;
}

// A party database to hold the switch? Then the switch is the ONLY memory —
// a save/load or a GM turning it off on the sheet must make him speak again.
function hasPartyStore() {
  try { return !!gameState()?.partyActor?.(); } catch { return false; }
}

// Was the line already said? Reads the switch (or this load's memory).
function alreadySaid(line) {
  if (!line.switchName) return false;
  if (hasPartyStore()) {
    try { return !!gameState().getSwitch(line.switchName); } catch { return false; }
  }
  return spokenThisLoad.has(line.switchName);
}

async function markSaid(line) {
  if (!line.switchName) return;
  if (hasPartyStore()) {
    try { await gameState().setSwitch(line.switchName, true); return; }
    catch (e) { console.warn("[FU BossLine] could not set switch", line.switchName, e); }
  }
  spokenThisLoad.add(line.switchName);
}

// GM side. Plays the skill's boss line if it has one and it is due, and
// resolves when the line has closed (capped). Returns true if a line played.
export async function playBossLine(ar, { skill = null } = {}) {
  try {
    if (!game.user?.isGM) return false;
    const item = skill ?? (ar?.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null);
    const line = readBossLine(item);
    if (!line || alreadySaid(line)) return false;
    const SM = globalThis.FU?.SystemMessage;
    if (!SM?.broadcast) return false;

    // Mark first, so a re-entered CONFIRM (F5 mid-line) never says it twice.
    await markSaid(line);

    let speaker = line.speaker;
    if (!speaker && ar?.attacker?.tokenUuid) {
      const tok = await fromUuid(ar.attacker.tokenUuid).catch(() => null);
      speaker = tok?.name ?? tok?.actor?.name ?? "";
    }
    const shown = SM.broadcast(bossLineMessage(line, speaker || item?.parent?.name || ""));
    await Promise.race([shown, new Promise((r) => setTimeout(r, MAX_WAIT_MS))]);
    return true;
  } catch (e) {
    console.warn("[FU BossLine] skipped", e);
    return false;
  }
}

// Tests only.
export function _resetBossLineMemory() { spokenThisLoad.clear(); }
