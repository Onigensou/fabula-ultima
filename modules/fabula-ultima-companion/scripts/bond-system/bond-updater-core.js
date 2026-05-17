// ============================================================================
// Bond Updater — Core API
//
// Universal API for reading/writing Fabula Ultima actor bond data.
// Independent of camp system — usable from macros, events, or any phase.
//
// Bond data schema — six fixed slots N = 1..6:
//   system.props.bond_N           — character name (plain text)
//   system.props.relationship_N   — relationship description (free text)
//   system.props.emotion_N_1      — pair 1: "" | "admiration" | "inferiority"
//   system.props.emotion_N_2      — pair 2: "" | "loyalty"    | "mistrust"
//   system.props.emotion_N_3      — pair 3: "" | "affection"  | "hatred"
//
// All reads go through actor.system.props.
// All writes go through actor.update() with flattened dot-notation paths.
// Never mutate actor.system.props directly.
// ============================================================================
(() => {
  const TAG = "[BondUpdater]";

  const PAIRS = Object.freeze([
    { pos: "admiration", neg: "inferiority" },
    { pos: "loyalty",    neg: "mistrust"    },
    { pos: "affection",  neg: "hatred"      },
  ]);

  const POSITIVE = new Set(["admiration", "loyalty", "affection"]);
  const NEGATIVE = new Set(["inferiority", "mistrust", "hatred"]);
  const MAX_BONDS = 6;

  globalThis.BondUpdater = {
    PAIRS,
    MAX_BONDS,

    /** Read all bond slots (1–6) from actor.system.props. */
    readBonds(actor) {
      const p = actor?.system?.props ?? {};
      const out = [];
      for (let i = 1; i <= MAX_BONDS; i++) {
        out.push({
          idx:  i,
          name: String(p[`bond_${i}`]         ?? ""),
          e1:   String(p[`emotion_${i}_1`]    ?? ""),
          e2:   String(p[`emotion_${i}_2`]    ?? ""),
          e3:   String(p[`emotion_${i}_3`]    ?? ""),
          rel:  String(p[`relationship_${i}`] ?? ""),
        });
      }
      return out;
    },

    /**
     * Write a single bond slot (N = 1–6) via actor.update().
     * Only the five canonical props for that slot are touched.
     * Returns the Foundry update result.
     */
    async writeSlot(actor, slotIdx, bondData) {
      if (!actor) throw new Error(`${TAG} writeSlot: actor required`);
      if (slotIdx < 1 || slotIdx > MAX_BONDS) throw new Error(`${TAG} writeSlot: slotIdx must be 1–${MAX_BONDS}`);

      const payload = {
        [`system.props.bond_${slotIdx}`]:         bondData.name ?? "",
        [`system.props.emotion_${slotIdx}_1`]:    bondData.e1   ?? "",
        [`system.props.emotion_${slotIdx}_2`]:    bondData.e2   ?? "",
        [`system.props.emotion_${slotIdx}_3`]:    bondData.e3   ?? "",
        [`system.props.relationship_${slotIdx}`]: bondData.rel  ?? "",
      };

      return actor.update(payload);
    },

    /**
     * Write multiple bond slots in a single actor.update() call.
     * Accepts an array of { idx, name, e1, e2, e3, rel } objects.
     * Only slots present in the array are written.
     */
    async writeBonds(actor, bonds) {
      if (!actor) throw new Error(`${TAG} writeBonds: actor required`);
      const payload = {};
      for (const b of bonds) {
        payload[`system.props.bond_${b.idx}`]         = b.name ?? "";
        payload[`system.props.emotion_${b.idx}_1`]    = b.e1   ?? "";
        payload[`system.props.emotion_${b.idx}_2`]    = b.e2   ?? "";
        payload[`system.props.emotion_${b.idx}_3`]    = b.e3   ?? "";
        payload[`system.props.relationship_${b.idx}`] = b.rel  ?? "";
      }
      return actor.update(payload);
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

    /** Emotion options for pair index 0–2. Returns ["", posEmotion, negEmotion]. */
    optionsForPair(pairIndex) {
      const p = PAIRS[pairIndex];
      return p ? ["", p.pos, p.neg] : [""];
    },

    /** Number of filled emotions (0–3). */
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

})();
