/**
 * [ONI] Event System — Logic
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-logic.js
 *
 * What this does:
 * - Holds the parts of the Event System that are plain calculation, with no
 *   canvas, socket or document in them:
 *     row lists (rows that own child lists, running them in order)
 *     conditions (switch / variable / this event's own memory)
 *     switch and variable table lookups on the party database sheet
 *     camera glide maths
 * - Everything here runs the same in the game and in a bare Node test
 *   (event-logic.test.mjs).
 *
 * Exposes API to:
 *   window.oni.EventSystem.Logic
 */

(() => {
  const root = (typeof window !== "undefined") ? window : globalThis;

  root.oni = root.oni || {};
  root.oni.EventSystem = root.oni.EventSystem || {};

  if (root.oni.EventSystem.Logic?.installed) return;

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function makeId() {
    const fromFoundry = root.foundry?.utils?.randomID;
    if (typeof fromFoundry === "function") return fromFoundry();
    return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
  }

  // ------------------------------------------------------------
  // Names
  // ------------------------------------------------------------
  // "Festival Score", "festival_score" and "festival score " are one name.
  function nameKey(raw) {
    return String(raw ?? "").trim().toLowerCase().replace(/[\s_\-]+/g, "");
  }

  function toNumber(raw, fallback = 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  // ------------------------------------------------------------
  // Row lists
  // ------------------------------------------------------------
  // getDef(type) returns the registered action, or null for a type nobody
  // registered. Such a row is kept exactly as written, so a script that failed
  // to load cannot cost the rows that needed it.
  function normalizeRows(rawRows, getDef) {
    let rows = rawRows;

    if (typeof rows === "string") {
      try { rows = JSON.parse(rows); } catch (_) { rows = []; }
    }
    if (!Array.isArray(rows)) rows = [];

    return rows.map((raw) => {
      const type = String(raw?.type || "").trim() || "showText";
      const def = getDef(type);

      if (!def) {
        const kept = clone(raw ?? {}) ?? {};
        kept.id = String(kept.id || makeId());
        kept.type = type;
        return kept;
      }

      const row = { ...(clone(def.defaultData) ?? {}), ...(clone(raw ?? {}) ?? {}) };
      row.id = String(row.id || makeId());
      row.type = type;

      def.prepare?.(row);

      for (const list of def.childLists?.(row) ?? []) {
        if (!Array.isArray(list?.rows)) continue;
        const normalized = normalizeRows(list.rows, getDef);
        list.rows.splice(0, list.rows.length, ...normalized);
      }

      return row;
    });
  }

  // Visit every row, children included. fn(row, depth).
  function walkRows(rows, getDef, fn, depth = 0) {
    for (const row of Array.isArray(rows) ? rows : []) {
      fn(row, depth);
      const def = getDef(String(row?.type || ""));
      for (const list of def?.childLists?.(row) ?? []) {
        walkRows(list?.rows, getDef, fn, depth + 1);
      }
    }
  }

  // Run a list in order.
  //   env.execute(row, index, total, next) -> result ({ ok, stop? })
  //                                  next: the row after it in this list, or null
  //   env.aborted()                  -> true once the event was ended early
  //   env.isCritical(row)            -> a failure of this row ends the event
  //   env.onSkip(row, result)        -> told about a failed row that was passed over
  // A result with stop:true ends the whole event, from however deep it came.
  async function runRows(rows, env) {
    const list = Array.isArray(rows) ? rows : [];

    for (let i = 0; i < list.length; i += 1) {
      if (env.aborted?.()) return { ok: true, stop: true, aborted: true };

      const row = list[i];
      let result;
      try {
        result = await env.execute(row, i, list.length, list[i + 1] ?? null);
      } catch (error) {
        result = { ok: false, reason: "executorError", error };
      }

      if (!result?.ok) {
        if (env.isCritical?.(row)) {
          return { ok: false, reason: "rowFailed", rowIndex: i, rowId: row?.id ?? null, result };
        }
        env.onSkip?.(row, result);
        continue;
      }

      if (result.stop) return result;
    }

    if (env.aborted?.()) return { ok: true, stop: true, aborted: true };
    return { ok: true };
  }

  // ------------------------------------------------------------
  // Conditions
  // ------------------------------------------------------------
  const CONDITION_KINDS = Object.freeze({
    NONE: "none",
    SWITCH: "switch",
    VARIABLE: "variable",
    SELF: "self",
    HAS_RUN: "hasRun",
    FABULA: "fabula",       // Fabula Points of the controller's character
    HAS_ITEM: "hasItem",    // how many of an item the party bag holds
    OFFERING: "offering",   // this event's last offering (Offer Item row)
    VERDICT: "verdict",     // the outcome of this event's last offering
    ZENIT: "zenit",
    MEMBER: "member",       // a character is in the party
    FORM: "form"            // a party member's Polymorph form has a tag (aquatic, flying…)
  });
  const FORM_WHO = Object.freeze(["any", "all"]);

  // What the Offering check tests.
  const OFFERING_TESTS = Object.freeze(["contains", "exactly", "count", "type"]);
  // Where a Zenit check reads from.
  const ZENIT_SOURCES = Object.freeze(["stash", "total", "controller"]);
  // The item types an offering can carry (item_type on the sheet -> label).
  const ITEM_TYPES = Object.freeze({
    weapon: "Weapon", armor: "Armor", shield: "Shield", accessory: "Accessory",
    consumable: "Consumable", material: "Material", key: "Key Item"
  });

  // "Blood, Bone , soul" -> ["Blood", "Bone", "soul"]
  function nameList(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    return list.map(s => String(s ?? "").trim()).filter(Boolean);
  }

  const COMPARE_OPS = Object.freeze(["=", "!=", ">", ">=", "<", "<="]);
  const SELF_SLOTS = Object.freeze(["A", "B", "C", "D"]);

  function normalizeCondition(raw) {
    const kind = Object.values(CONDITION_KINDS).includes(raw?.kind) ? raw.kind : CONDITION_KINDS.NONE;
    const cond = { kind };

    if (kind === CONDITION_KINDS.SWITCH) {
      cond.name = String(raw?.name ?? "").trim();
      cond.want = raw?.want === "off" ? "off" : "on";
    } else if (kind === CONDITION_KINDS.VARIABLE) {
      cond.name = String(raw?.name ?? "").trim();
      cond.op = COMPARE_OPS.includes(raw?.op) ? raw.op : "=";
      cond.value = toNumber(raw?.value, 0);
    } else if (kind === CONDITION_KINDS.SELF) {
      cond.slot = SELF_SLOTS.includes(raw?.slot) ? raw.slot : "A";
      cond.want = raw?.want === "off" ? "off" : "on";
    } else if (kind === CONDITION_KINDS.HAS_RUN) {
      cond.want = raw?.want === "no" ? "no" : "yes";
    } else if (kind === CONDITION_KINDS.FABULA) {
      cond.op = COMPARE_OPS.includes(raw?.op) ? raw.op : ">=";
      cond.value = toNumber(raw?.value, 1);
    } else if (kind === CONDITION_KINDS.HAS_ITEM) {
      cond.name = String(raw?.name ?? "").trim();
      cond.op = COMPARE_OPS.includes(raw?.op) ? raw.op : ">=";
      cond.value = toNumber(raw?.value, 1);
    } else if (kind === CONDITION_KINDS.OFFERING) {
      cond.test = OFFERING_TESTS.includes(raw?.test) ? raw.test : "contains";
      cond.name = String(raw?.name ?? "").trim();
      cond.names = nameList(raw?.names);
      cond.itemType = Object.keys(ITEM_TYPES).includes(raw?.itemType) ? raw.itemType : "key";
      cond.op = COMPARE_OPS.includes(raw?.op) ? raw.op : ">=";
      cond.value = toNumber(raw?.value, 1);
    } else if (kind === CONDITION_KINDS.VERDICT) {
      cond.name = String(raw?.name ?? "").trim();
    } else if (kind === CONDITION_KINDS.ZENIT) {
      cond.source = ZENIT_SOURCES.includes(raw?.source) ? raw.source : "stash";
      cond.op = COMPARE_OPS.includes(raw?.op) ? raw.op : ">=";
      cond.value = toNumber(raw?.value, 0);
    } else if (kind === CONDITION_KINDS.MEMBER) {
      cond.name = String(raw?.name ?? "").trim();
      cond.want = raw?.want === "out" ? "out" : "in";
    } else if (kind === CONDITION_KINDS.FORM) {
      cond.tag = String(raw?.tag ?? "").trim().toLowerCase();
      cond.who = FORM_WHO.includes(raw?.who) ? raw.who : "any";
      cond.want = raw?.want === "no" ? "no" : "yes";
    }

    return cond;
  }

  // A Condition row may hold several checks. Its first check stays in
  // row.condition (as before), the others in row.moreConditions, joined by
  // row.combine: "all" (every check) or "any" (one is enough).
  function conditionSet(row) {
    const list = [row?.condition, ...(Array.isArray(row?.moreConditions) ? row.moreConditions : [])]
      .filter(c => c !== undefined && c !== null)
      .map(normalizeCondition);
    return { mode: row?.combine === "any" ? "any" : "all", list: list.length ? list : [normalizeCondition(null)] };
  }

  function evalConditionSet(row, reader) {
    const { mode, list } = conditionSet(row);
    return mode === "any" ? list.some(c => evalCondition(c, reader)) : list.every(c => evalCondition(c, reader));
  }

  function describeConditionSet(row) {
    const { mode, list } = conditionSet(row);
    return list.map(describeCondition).join(mode === "any" ? " OR " : " AND ");
  }

  // Does a check need the controller's character resolved first?
  function needsController(cond) {
    const c = normalizeCondition(cond);
    return c.kind === CONDITION_KINDS.FABULA || (c.kind === CONDITION_KINDS.ZENIT && c.source === "controller");
  }

  // ------------------------------------------------------------
  // Offerings (Offer Item row)
  // ------------------------------------------------------------
  // offered: [{ name, type }], type = an item_type key (weapon, key, ...).
  // rule: { mode: "free" | "specific" | "type", names, itemType }
  // "specific" passes when the offering holds every listed name, in any
  // order, and nothing else (a name listed twice must be offered twice).
  function judgeOffering(rule, offered) {
    const items = Array.isArray(offered) ? offered : [];
    if (rule?.mode === "type") return items.length > 0 && items.every(i => i?.type === rule.itemType);
    if (rule?.mode === "specific") {
      const want = nameList(rule?.names).map(nameKey).sort();
      const got = items.map(i => nameKey(i?.name)).sort();
      return want.length > 0 && want.length === got.length && want.every((n, i) => n === got[i]);
    }
    return items.length > 0;
  }

  // May this item go into the offer box at all? (Only "one type" limits it.)
  function offerAllows(rule, item) {
    return rule?.mode !== "type" || item?.type === rule.itemType;
  }

  function compare(left, op, right) {
    const a = toNumber(left, 0);
    const b = toNumber(right, 0);
    switch (op) {
      case "!=": return a !== b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "<": return a < b;
      case "<=": return a <= b;
      default: return a === b;
    }
  }

  // reader: { switch(name) -> bool, variable(name) -> number,
  //           self(slot) -> bool, runs() -> number }
  //   newer: fabula() -> number (controller's character), itemCount(name),
  //          offering() -> { items: [{ name, type }], verdict } | null,
  //          zenit(source) -> number, member(name) -> bool.
  //   A reader without one of the newer functions reads 0 / nothing.
  function evalCondition(rawCond, reader) {
    const cond = normalizeCondition(rawCond);
    const call = (fn, ...args) => (typeof reader?.[fn] === "function" ? reader[fn](...args) : undefined);

    switch (cond.kind) {
      case CONDITION_KINDS.SWITCH:
        return !!reader.switch(cond.name) === (cond.want === "on");
      case CONDITION_KINDS.VARIABLE:
        return compare(reader.variable(cond.name), cond.op, cond.value);
      case CONDITION_KINDS.SELF:
        return !!reader.self(cond.slot) === (cond.want === "on");
      case CONDITION_KINDS.HAS_RUN:
        return (toNumber(reader.runs(), 0) > 0) === (cond.want === "yes");
      case CONDITION_KINDS.FABULA:
        return compare(call("fabula"), cond.op, cond.value);
      case CONDITION_KINDS.HAS_ITEM:
        return compare(call("itemCount", cond.name), cond.op, cond.value);
      case CONDITION_KINDS.OFFERING: {
        const items = call("offering")?.items ?? [];
        if (cond.test === "count") return compare(items.length, cond.op, cond.value);
        if (cond.test === "type") return items.some(i => i?.type === cond.itemType);
        if (cond.test === "exactly") return judgeOffering({ mode: "specific", names: cond.names }, items);
        const want = nameKey(cond.name);
        return !!want && items.some(i => nameKey(i?.name) === want);
      }
      case CONDITION_KINDS.VERDICT: {
        const got = call("offering")?.verdict;
        return !!got && nameKey(got) === nameKey(cond.name);
      }
      case CONDITION_KINDS.ZENIT:
        return compare(call("zenit", cond.source), cond.op, cond.value);
      case CONDITION_KINDS.MEMBER:
        return !!call("member", cond.name) === (cond.want === "in");
      case CONDITION_KINDS.FORM:
        // reader.formTag(tag, who) — "" tag = any Polymorph form at all.
        return !!call("formTag", cond.tag, cond.who) === (cond.want === "yes");
      default:
        return true;
    }
  }

  function describeCondition(rawCond) {
    const cond = normalizeCondition(rawCond);
    switch (cond.kind) {
      case CONDITION_KINDS.SWITCH: return `Switch "${cond.name}" is ${cond.want}`;
      case CONDITION_KINDS.VARIABLE: return `Variable "${cond.name}" ${cond.op} ${cond.value}`;
      case CONDITION_KINDS.SELF: return `This event's switch ${cond.slot} is ${cond.want}`;
      case CONDITION_KINDS.HAS_RUN: return cond.want === "yes" ? "This event has run before" : "This event has not run yet";
      case CONDITION_KINDS.FABULA: return `Controller's Fabula Points ${cond.op} ${cond.value}`;
      case CONDITION_KINDS.HAS_ITEM: return `Party has "${cond.name}" ${cond.op} ${cond.value}`;
      case CONDITION_KINDS.OFFERING:
        if (cond.test === "count") return `Last offering count ${cond.op} ${cond.value}`;
        if (cond.test === "type") return `Last offering includes a ${ITEM_TYPES[cond.itemType]}`;
        if (cond.test === "exactly") return `Last offering is exactly ${cond.names.join(", ")}`;
        return `Last offering contains "${cond.name}"`;
      case CONDITION_KINDS.VERDICT: return `Last offering's verdict is "${cond.name}"`;
      case CONDITION_KINDS.ZENIT: return `Zenit (${cond.source}) ${cond.op} ${cond.value}`;
      case CONDITION_KINDS.MEMBER: return `"${cond.name}" is ${cond.want === "in" ? "in" : "not in"} the party`;
      case CONDITION_KINDS.FORM: {
        const what = cond.tag ? `a "${cond.tag}" form` : "a Polymorph form";
        const who = cond.who === "all" ? "Every party member is in" : "A party member is in";
        return cond.want === "yes" ? `${who} ${what}` : `Not: ${who.toLowerCase()} ${what}`;
      }
      default: return "Always";
    }
  }

  // Is the event offered at all? settings: { onceOnly, availableWhen }.
  // reader adds erased() to the condition reader.
  function eventAvailable(settings, reader) {
    if (reader.erased?.()) return false;
    if (settings?.onceOnly && toNumber(reader.runs(), 0) > 0) return false;
    return evalCondition(settings?.availableWhen, reader);
  }

  // How an event starts: from its "!" button (RPG Maker's Action Button), or
  // by itself when the party steps into its range (Player Touch).
  const START_MODES = { BUTTON: "button", STEP_IN: "stepIn" };

  function normalizeStartMode(raw) {
    return raw === START_MODES.STEP_IN ? START_MODES.STEP_IN : START_MODES.BUTTON;
  }

  // One scan of a step-in event. It fires on the step in, not on standing
  // there, so an event that can repeat does not loop under the party. While
  // another event is busy the step does not count yet: it fires once that ends.
  function stepInStep({ inRange, wasInside, busy, available }) {
    if (!inRange) return { inside: false, start: false };
    if (wasInside) return { inside: true, start: false };
    if (busy) return { inside: false, start: false };
    return { inside: true, start: !!available };
  }

  // Does anything about this event read how often it has run? Only then is a
  // run worth a write to the party sheet.
  function usesRunMemory(rows, settings, getDef) {
    if (settings?.onceOnly) return true;
    if (normalizeCondition(settings?.availableWhen).kind === CONDITION_KINDS.HAS_RUN) return true;

    let found = false;
    walkRows(rows, getDef, (row) => {
      if (conditionSet(row).list.some(c => c.kind === CONDITION_KINDS.HAS_RUN)) found = true;
    });
    return found;
  }

  // ------------------------------------------------------------
  // Text: {var:name} prints a variable
  // ------------------------------------------------------------
  // A number prints as a number (blank → 0, as before); text prints as written
  // (a party name stored by Name Input).
  function substituteVars(text, getVariable) {
    return String(text ?? "").replace(/\{var:([^}]+)\}/gi, (_, name) => {
      const value = getVariable(String(name).trim());
      const raw = String(value ?? "").trim();
      if (raw && !Number.isFinite(Number(raw))) return raw;
      return String(toNumber(value, 0));
    });
  }

  // ------------------------------------------------------------
  // Switch / variable tables on the party database sheet
  // A CSB table is an object of rows keyed "0", "1", ... ; a removed row
  // stays in it with $deleted set.
  // ------------------------------------------------------------
  function liveTableRows(table) {
    return Object.entries(table && typeof table === "object" ? table : {})
      .filter(([, row]) => row && typeof row === "object" && row.$deleted !== true);
  }

  function findTableKey(table, nameField, name) {
    const wanted = nameKey(name);
    if (!wanted) return null;
    for (const [key, row] of liveTableRows(table)) {
      if (nameKey(row[nameField]) === wanted) return key;
    }
    return null;
  }

  function nextTableKey(table) {
    let max = -1;
    for (const key of Object.keys(table && typeof table === "object" ? table : {})) {
      const n = Number(key);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  function tableNames(table, nameField) {
    return liveTableRows(table)
      .map(([, row]) => String(row[nameField] ?? "").trim())
      .filter(Boolean);
  }

  function isOn(raw) {
    if (raw === true) return true;
    const s = String(raw ?? "").trim().toLowerCase();
    return s === "on" || s === "true" || s === "1" || s === "yes";
  }

  // ------------------------------------------------------------
  // Camera glide
  // ------------------------------------------------------------
  function clamp01(t) {
    return Math.min(1, Math.max(0, t));
  }

  function easeInOutQuad(t) {
    const x = clamp01(t);
    return x < 0.5 ? 2 * x * x : 1 - (Math.pow(-2 * x + 2, 2) / 2);
  }

  // Share of the move at time t for a pull-back: a short ease in, a steady
  // middle, a longer settle (measured from a filmed dolly, JoJo OP2 1:00-1:04).
  const PULL_IN = 0.12;
  const PULL_OUT = 0.4;

  function pullBackShare(t) {
    const x = clamp01(t);
    const peak = 1 / (1 - (PULL_IN / 2) - (PULL_OUT / 2));
    if (x < PULL_IN) return peak * x * x / (2 * PULL_IN);
    if (x <= 1 - PULL_OUT) return peak * (x - (PULL_IN / 2));
    return 1 - (peak * (1 - x) * (1 - x) / (2 * PULL_OUT));
  }

  // Where a glide is at time `now`. from / to: { x, y, scale }.
  // motion "pullBack": the zoom changes by a steady ratio, not a steady amount,
  // and the centre moves with the size of the view, so one point of the map
  // holds still on screen as it would under a real camera moving back.
  function glideAt(from, to, startedAt, durationMs, now, motion = "smooth") {
    const span = Math.max(0, toNumber(durationMs, 0));
    const t = span <= 0 ? 1 : clamp01((now - startedAt) / span);

    if (motion === "pullBack" && from.scale > 0 && to.scale > 0 && from.scale !== to.scale) {
      const scale = from.scale * Math.pow(to.scale / from.scale, pullBackShare(t));
      const k = ((1 / scale) - (1 / from.scale)) / ((1 / to.scale) - (1 / from.scale));
      return {
        x: from.x + ((to.x - from.x) * k),
        y: from.y + ((to.y - from.y) * k),
        scale,
        done: t >= 1
      };
    }

    const e = easeInOutQuad(t);
    return {
      x: from.x + ((to.x - from.x) * e),
      y: from.y + ((to.y - from.y) * e),
      scale: from.scale + ((to.scale - from.scale) * e),
      done: t >= 1
    };
  }

  root.oni.EventSystem.Logic = {
    installed: true,

    clone,
    makeId,
    nameKey,
    toNumber,

    normalizeRows,
    walkRows,
    runRows,

    CONDITION_KINDS,
    COMPARE_OPS,
    SELF_SLOTS,
    OFFERING_TESTS,
    ZENIT_SOURCES,
    ITEM_TYPES,
    nameList,
    normalizeCondition,
    compare,
    evalCondition,
    describeCondition,
    conditionSet,
    evalConditionSet,
    describeConditionSet,
    needsController,
    judgeOffering,
    offerAllows,
    eventAvailable,
    usesRunMemory,

    START_MODES,
    normalizeStartMode,
    stepInStep,

    substituteVars,

    liveTableRows,
    findTableKey,
    nextTableKey,
    tableNames,
    isOn,

    clamp01,
    easeInOutQuad,
    glideAt
  };
})();
