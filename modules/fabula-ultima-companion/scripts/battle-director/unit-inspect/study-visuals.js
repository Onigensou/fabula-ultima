// Study Card — the visual vocabulary shared by the Inspect card, its hover peek
// and the Party Menu Bestiary tiles. Pure data + string building.
//
// Approved mockup: claude.ai/artifact/S3qYiJB3qMCP9MAa6DbMwb (2026-11-02).

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";

export const SFX_NAV = `${FORGE}/Sound/BattleCursor_3.wav`;
export const SFX_OPEN = `${FORGE}/Sound/Soundboard/Book1.ogg`;

export const ATTR_ICON = {
  MIG: `${FORGE}/Item%20Icon/asan.png`,
  DEX: `${FORGE}/Item%20Icon/boot.png`,
  INS: `${FORGE}/Item%20Icon/book.png`,
  WLP: `${FORGE}/Item%20Icon/stat.png`,
};
export const ATTR_NAME = { MIG: "Might", DEX: "Dexterity", INS: "Insight", WLP: "Willpower" };

// Sword and Dagger each need their own icon here: the card has no text label to
// tell them apart.
export const WEAPON_ICON = {
  arcane: "fa-book", bow: "fa-bullseye", brawling: "fa-hand-fist", dagger: "fa-dagger", firearm: "fa-gun",
  flail: "fa-gavel", heavy: "fa-hammer", spear: "fa-location-arrow", sword: "fa-sword", thrown: "fa-bomb",
};

const RANKS = {
  soldier: { label: "Soldier", tip: "Soldier: the standard enemy." },
  elite: { label: "Elite", tip: "Elite: counts as two Soldiers." },
  champion: { label: "Champion", tip: "Champion: boss class, counts as several Soldiers." },
  villain: { label: "Villain", tip: "Villain: a major enemy of the story." },
};

/** Authored ranks come as full names and 3-letter forms ("cha"): read the prefix. */
export function rankKeyOf(raw) {
  const head = String(raw ?? "").trim().toLowerCase().slice(0, 3);
  return { sol: "soldier", eli: "elite", cha: "champion", vil: "villain" }[head] ?? "";
}

export const rankInfo = (key) => (RANKS[key] ? { key, ...RANKS[key] } : null);

const SHIELD = "M32 4 L56 12 V32 C56 46 45 55 32 60 C19 55 8 46 8 32 V12 Z";
const SHINE = "M32 4 L8 12 V32 C8 46 19 55 32 60 Z";

/** The rank shield. An empty key is the blank crest of a creature not yet identified. */
export function crestSVG(key, size = 60) {
  const svg = (body) => `<svg class="fu-crest" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
  if (!RANKS[key]) {
    return svg(`<path d="${SHIELD}" fill="rgba(59,42,25,.07)" stroke="#8a7d6a" stroke-width="2.5" stroke-dasharray="5 4"/><text x="32" y="41" text-anchor="middle" font-size="25" font-weight="700" fill="#8a7d6a" font-family="Signika,sans-serif">?</text>`);
  }
  if (key === "soldier") {
    return svg(`<path d="${SHIELD}" fill="#7d8487" stroke="#33383b" stroke-width="3"/><path d="${SHINE}" fill="#fff" opacity=".13"/><path d="M18 29 L32 40 L46 29" fill="none" stroke="#f1eee4" stroke-width="6"/>`);
  }
  if (key === "elite") {
    return svg(`<path d="${SHIELD}" fill="#2e4f86" stroke="#e0bb55" stroke-width="4"/><path d="${SHINE}" fill="#fff" opacity=".12"/><path d="M18 19 L32 30 L46 19" fill="none" stroke="#f6e8bf" stroke-width="5.5"/><path d="M18 33 L32 44 L46 33" fill="none" stroke="#f6e8bf" stroke-width="5.5"/>`);
  }
  return svg(`<path d="${SHIELD}" fill="#8e1f17" stroke="#f0c95a" stroke-width="4.5"/><path d="${SHINE}" fill="#fff" opacity=".1"/><path d="M17 27 L17 12 L25 20 L32 9 L39 20 L47 12 L47 27 Z" fill="#f0c95a" stroke="#5a3b08" stroke-width="1.8"/><polygon points="32,31 35.6,39 44,39.6 37.5,45 39.6,53 32,48.6 24.4,53 26.5,45 20,39.6 28.4,39" fill="#ffe9a8" stroke="#5a3b08" stroke-width="1.4"/>`);
}

/** DEF is a shield; M.DEF a six-sided ward, so the two differ by outline as well as colour. */
export function defenseSVG(kind) {
  const paths = kind === "mdef"
    ? `<path d="M12 .8 22.6 7v14L12 27.2 1.4 21V7z" style="fill:var(--sh-rim)"/><path d="M12 3.1 20.6 8.1v11.8L12 24.9 3.4 19.9V8.1z" style="fill:var(--sh-bot)"/><path d="M12 3.1 3.4 8.1v11.8L12 24.9z" style="fill:var(--sh-top)" opacity=".55"/>`
    : `<path d="M12 1.5 2.5 4.6v8.3c0 6 4.1 10.6 9.5 13.6 5.4-3 9.5-7.6 9.5-13.6V4.6z" style="fill:var(--sh-rim)"/><path d="M12 3.6 4.4 6.1v6.8c0 4.9 3.3 8.7 7.6 11.2 4.3-2.5 7.6-6.3 7.6-11.2V6.1z" style="fill:var(--sh-bot)"/><path d="M12 3.6 4.4 6.1v6.8c0 4.9 3.3 8.7 7.6 11.2V3.6z" style="fill:var(--sh-top)" opacity=".55"/>`;
  return `<svg viewBox="0 0 24 28" aria-hidden="true">${paths}</svg>`;
}

/** A printed action cost as chip data. "-" and blank mean No cost. */
export function costChip(raw, mpNow = null) {
  const text = String(raw ?? "").trim();
  if (!text || text === "-") return { text: "No cost", cls: "free", short: false, tip: "" };
  const shown = text.replace(/\s+x\s+/i, " × ");
  const cls = /zero|\bzp\b/i.test(text) ? "zp" : /\bip\b/i.test(text) ? "ip" : /\bmp\b/i.test(text) ? "mp" : /\bhp\b/i.test(text) ? "hp" : "free";
  const m = /^(\d+)\s*MP$/i.exec(text);
  const short = !!m && mpNow != null && Number(m[1]) > mpNow;
  return { text: shown, cls: short ? "short" : cls, short, tip: short ? `Needs ${m[1]} MP. It has ${mpNow}.` : "" };
}
