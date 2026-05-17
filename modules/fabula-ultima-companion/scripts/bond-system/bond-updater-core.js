// ============================================================================
// Bond Updater — Core API
//
// Universal API for reading/writing Fabula Ultima actor bond data.
// Independent of camp system — usable from macros, events, or any phase.
//
// Bond data schema per slot 1–6:
//   system.props.bond_N           — character name
//   system.props.relationship_N   — relationship description (free text)
//   system.props.emotion_N_1      — pair 1: Admiration | Inferiority
//   system.props.emotion_N_2      — pair 2: Loyalty    | Mistrust
//   system.props.emotion_N_3      — pair 3: Affection  | Hatred
// ============================================================================
(() => {
  const TAG = "[BondUpdater]";

  const PAIRS = Object.freeze([
    { pos: "Admiration", neg: "Inferiority" },
    { pos: "Loyalty",    neg: "Mistrust"    },
    { pos: "Affection",  neg: "Hatred"      },
  ]);

  const POSITIVE = new Set(["Admiration", "Loyalty", "Affection"]);
  const NEGATIVE = new Set(["Inferiority", "Mistrust", "Hatred"]);
  const MAX_BONDS = 6;

  globalThis.BondUpdater = {
    PAIRS,
    MAX_BONDS,

    /** Read all bond slots (1–6) from an actor. */
    readBonds(actor) {
      const p = actor?.system?.props ?? {};
      const out = [];
      for (let i = 1; i <= MAX_BONDS; i++) {
        out.push({
          idx:  i,
          name: String(p[`bond_${i}`]          ?? ""),
          e1:   String(p[`emotion_${i}_1`]     ?? ""),
          e2:   String(p[`emotion_${i}_2`]     ?? ""),
          e3:   String(p[`emotion_${i}_3`]     ?? ""),
          rel:  String(p[`relationship_${i}`]  ?? ""),
        });
      }
      return out;
    },

    /** Write an array of bond objects back to the actor. */
    async writeBonds(actor, bonds) {
      if (!actor) throw new Error(`${TAG} writeBonds: actor required`);
      const data = {};
      for (const b of bonds) {
        data[`system.props.bond_${b.idx}`]          = b.name  ?? "";
        data[`system.props.emotion_${b.idx}_1`]     = b.e1   ?? "";
        data[`system.props.emotion_${b.idx}_2`]     = b.e2   ?? "";
        data[`system.props.emotion_${b.idx}_3`]     = b.e3   ?? "";
        data[`system.props.relationship_${b.idx}`]  = b.rel  ?? "";
      }
      return actor.update(data);
    },

    /**
     * Build a diff log between original and updated bond arrays.
     * Returns Array<{ type:"add"|"update"|"remove", slot, before?, after? }>
     */
    buildChangelog(original, updated) {
      const log = [];
      for (const b of updated) {
        const orig = original.find(o => o.idx === b.idx);
        if (!orig) continue;
        const changed = b.name !== orig.name || b.e1 !== orig.e1 ||
                        b.e2   !== orig.e2   || b.e3 !== orig.e3 || b.rel !== orig.rel;
        if (!changed) continue;
        if (!orig.name && b.name)      log.push({ type: "add",    slot: b.idx, after:  { ...b } });
        else if (orig.name && !b.name) log.push({ type: "remove", slot: b.idx, before: { ...orig } });
        else                           log.push({ type: "update",  slot: b.idx, before: { ...orig }, after: { ...b } });
      }
      return log;
    },

    /**
     * Emotion options for pair index 0–2 (matches emotion_N_1, _2, _3).
     * Returns ["", posEmotion, negEmotion].
     */
    optionsForPair(pairIndex) {
      const p = PAIRS[pairIndex];
      return p ? ["", p.pos, p.neg] : [""];
    },

    /** Number of filled emotions (0–3) — the bond's "level". */
    bondLevel(bond) {
      return [bond.e1, bond.e2, bond.e3].filter(e => e?.trim()).length;
    },

    /** Returns "positive", "negative", or "none". */
    emotionPolarity(emotion) {
      if (!emotion) return "none";
      if (POSITIVE.has(emotion)) return "positive";
      if (NEGATIVE.has(emotion)) return "negative";
      return "none";
    },
  };

  console.debug(TAG, "Bond Updater API loaded.");
})();
