/**
 * [ONI] Event System — Lint
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-lint.js
 *
 * What this does:
 * - Reads every event in the world (tiles and tokens, all scenes) and lists
 *   what is likely a mistake. Nothing is changed.
 *     a switch or variable that is tested but never set (the usual typo)
 *     one name written two ways ("Boss Down" / "boss_down")
 *     an action with nothing in it (no text, no sound file, no answers)
 *     an action type no script provides
 * - Run it from the console:
 *     FUCompanion.api.lint.runEventLint()
 *     FUCompanion.api.lint.runEventLint({ sceneId: canvas.scene.id })
 *
 * Requires:
 * - event-constants.js, event-logic.js, event-eventRegistry.js, event-gameState.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][Lint]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Lint?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!C || !Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Constants, Logic or EventRegistry. Check load order.");
    return;
  }

  const K = Logic.CONDITION_KINDS;

  function eventSources(scene) {
    const out = [];
    for (const doc of [...(scene.tiles ?? []), ...(scene.tokens ?? [])]) {
      const data = doc.flags?.[C.FLAG_SCOPE];
      if (!data || data.isEventTile !== true) continue;

      const rows = EventRegistry.normalizeRows(data.eventRows ?? []);
      if (!rows.length) continue;

      out.push({
        scene: scene.name,
        source: doc.documentName === "Token"
          ? (doc.name || "token")
          : (doc.flags?.["fabula-ultima-companion"]?.draftName || `tile ${doc.id}`),
        sourceId: doc.id,
        rows,
        availableWhen: data.availableWhen ?? null
      });
    }
    return out;
  }

  // Record one use of a switch or variable name.
  function note(book, name, kind, where) {
    const raw = String(name ?? "").trim();
    const key = Logic.nameKey(raw);
    if (!key) return;
    if (!book.has(key)) book.set(key, { spellings: new Set(), read: [], written: [] });
    const entry = book.get(key);
    entry.spellings.add(raw);
    entry[kind].push(where);
  }

  // The way Camera Pan and Set Token find a token: its own name or its actor's.
  function hasToken(scene, name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    return (scene.tokens?.contents ?? []).some(t =>
      String(t.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    );
  }

  function noteCondition(cond, where, switches, variables) {
    const c = Logic.normalizeCondition(cond);
    if (c.kind === K.SWITCH) note(switches, c.name, "read", where);
    if (c.kind === K.VARIABLE) note(variables, c.name, "read", where);
  }

  function runEventLint({ sceneId = null } = {}) {
    const issues = [];
    const switches = new Map();
    const variables = new Map();

    const scenes = sceneId ? [game.scenes?.get(sceneId)].filter(Boolean) : [...(game.scenes ?? [])];
    let eventCount = 0;

    for (const scene of scenes) {
      for (const ev of eventSources(scene)) {
        eventCount += 1;
        const at = `${ev.scene} / ${ev.source}`;
        const add = (level, message) => issues.push({ level, where: at, message });

        noteCondition(ev.availableWhen, at, switches, variables);

        // Does this event make an offering a later check could read?
        let offers = false;
        EventRegistry.walkRows(ev.rows, (row) => { if (row?.type === "offerItem") offers = true; });

        EventRegistry.walkRows(ev.rows, (row) => {
          const type = String(row?.type || "");

          if (!EventRegistry.has(type)) {
            add("error", `Unknown action type "${type}": it is skipped when the event runs.`);
            return;
          }

          for (const [, name] of String(row.text ?? "").matchAll(/\{var:([^}]+)\}/gi)) {
            note(variables, name, "read", at);
          }

          switch (type) {
            case "showText":
              if (!String(row.text ?? "").trim()) add("warn", "Show Text with no text.");
              break;
            case "floatingText":
              if (!String(row.text ?? "").trim()) add("warn", "Floating Text with no text.");
              if (row.place === "token" && !String(row.name ?? "").trim()) add("warn", "Floating Text beside a named token, with no name.");
              break;
            case "playSound":
              if (!String(row.src ?? "").trim()) add("warn", "Play Sound with no file.");
              break;
            case "playBGM": {
              const track = String(row.track ?? "").trim();
              if (!track) add("warn", "Play BGM with no track.");
              else if (![...(game.playlists ?? [])].some(p => p.sounds?.getName?.(track))) add("warn", `Play BGM names "${track}", but no playlist has that track.`);
              break;
            }
            case "playAnimation":
              if (!String(row.src ?? "").trim()) add("warn", "Play Animation with no file.");
              if (row.where === "token" && !String(row.name ?? "").trim()) add("warn", "Play Animation on a named token, with no name.");
              break;
            case "cameraPan":
              if (row.mode === "token" && !String(row.name ?? "").trim()) add("warn", "Camera Pan to a named token, with no name.");
              else if (row.mode === "token" && !hasToken(scene, row.name)) add("warn", `Camera Pan to "${row.name}", but no token on this scene has that name. The camera would stay put.`);
              break;
            case "setToken": {
              const names = String(row.name ?? "").split(",").map(s => s.trim()).filter(Boolean);
              if (!names.length) add("warn", "Set Token with no name.");
              for (const name of names) if (!hasToken(scene, name)) add("warn", `Set Token names "${name}", but no token on this scene has that name. If it was deleted, hide it instead, or take it out of this row.`);
              break;
            }
            case "setFacing":
              if (row.target === "token") {
                const names = String(row.name ?? "").split(",").map(s => s.trim()).filter(Boolean);
                if (!names.length) add("warn", "Set Facing on a named token, with no name.");
                for (const name of names) if (!hasToken(scene, name)) add("warn", `Set Facing names "${name}", but no token on this scene has that name.`);
              }
              break;
            case "setTokenPosition":
              if (row.target === "token" && !String(row.name ?? "").trim()) add("warn", "Set Token Position on a named token, with no name.");
              if (row.mode !== "point" && !String(row.mark ?? "").trim()) add("warn", "Set Token Position on a marker token, with no marker.");
              else if (row.mode !== "point" && !hasToken(scene, row.mark)) add("warn", `Set Token Position names the marker "${row.mark}", but no token on this scene has that name.`);
              break;
            case "showEmote":
              if (row.target === "token" && !String(row.name ?? "").trim()) add("warn", "Show Emote on a named token, with no name.");
              else if (row.target === "token" && !hasToken(scene, row.name)) add("warn", `Show Emote on "${row.name}", but no token on this scene has that name.`);
              break;
            case "lightningReveal":
              for (const line of String(row.lit ?? "").split("\n")) {
                const [name] = line.split("=");
                if (String(name ?? "").trim() && !hasToken(scene, name)) add("warn", `Lightning Reveal names "${String(name).trim()}", but no token on this scene has that name.`);
              }
              break;
            case "pauseForGM":
              if ((row.choices ?? []).some(c => !String(c.label ?? "").trim())) add("warn", "Pause for GM has a choice with no text.");
              break;
            case "jumpTo": {
              const lines = String(row.path ?? "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
              if (!lines.length) add("warn", "Jump To with no path.");
              for (const line of lines) {
                if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(line)) continue;
                if (!hasToken(scene, line)) add("warn", `Jump To names the marker "${line}", but no token on this scene has that name. The jump would be skipped.`);
              }
              break;
            }
            case "runCode": {
              const err = window.oni.EventSystem.RunCode?.syntaxError?.(row.code);
              if (!String(row.code ?? "").trim()) add("warn", "Run Code with no code.");
              else if (err) add("error", `Run Code does not parse: ${err}`);
              break;
            }
            case "condition": {
              const set = Logic.conditionSet(row);
              for (const c of set.list) {
                noteCondition(c, at, switches, variables);
                if ((c.kind === K.OFFERING || c.kind === K.VERDICT) && !offers) {
                  add("warn", "Condition reads this event's last offering, but the event has no Offer Item row.");
                }
                if ((c.kind === K.HAS_ITEM || c.kind === K.MEMBER) && !c.name) add("warn", "Condition checks an item or party member with no name.");
              }
              const elseCounts = row.hasElse !== false;
              if (!row.thenRows?.length && !(elseCounts && row.elseRows?.length)) add("warn", "Condition with nothing under Then or Else.");
              break;
            }
            case "offerItem": {
              const names = Logic.nameList(row.names);
              if (row.mode === "specific" && !names.length) add("warn", "Offer Item asks for specific items but lists none: nothing can pass.");
              if (row.mode === "specific" && names.length && names.length !== Number(row.count)) {
                add("warn", `Offer Item asks for ${row.count} item(s) but lists ${names.length} name(s): the offering can never match.`);
              }
              if (row.judge !== "auto" && (row.presets ?? []).some(p => !String(p.label ?? "").trim())) add("warn", "Offer Item has a verdict with no text.");
              break;
            }
            case "changeItems":
              if (row.what === "item" && !String(row.name ?? "").trim()) add("warn", "Change Items with no item name.");
              if (row.what === "item" && row.op !== "remove" && String(row.name ?? "").trim() && !window.oni.EventSystem.RowsItems?.worldItemByName?.(row.name)) {
                add("warn", `Change Items adds "${row.name}", but no world item has that name.`);
              }
              if (row.what === "offered" && !offers) add("warn", "Change Items removes the offered items, but the event has no Offer Item row.");
              break;
            case "setSwitch":
              if (row.scope !== "self") {
                if (!String(row.name ?? "").trim()) add("warn", "Set Switch with no name.");
                else note(switches, row.name, "written", at);
              }
              break;
            case "setVariable":
              if (!String(row.name ?? "").trim()) add("warn", "Set Variable with no name.");
              else note(variables, row.name, "written", at);
              break;
            case "runCheck":
              if ((row.targets ?? []).some(t => t.kind === "name" && !String(t.name ?? "").trim())) add("warn", "Run Check has a named target with no name.");
              if (!row.successRows?.length && !row.failureRows?.length) add("info", "Run Check where neither Success nor Failure does anything.");
              if (String(row.storeVar ?? "").trim()) note(variables, row.storeVar, "written", at);
              break;
            case "showChoices": {
              const options = row.options ?? [];
              if (options.some(o => !String(o.label ?? "").trim())) add("warn", "Show Choices has an answer with no text.");
              if (options.every(o => !o.rows?.length)) add("info", "Show Choices where no answer does anything.");
              break;
            }
            default:
              break;
          }
        });
      }
    }

    // Names: tested but never set anywhere, and one name spelt two ways.
    const state = window.oni.EventSystem.GameState;
    const onSheet = (names) => new Set((names ?? []).map(n => Logic.nameKey(n)));
    const sheetSwitches = onSheet(state?.switchNames?.());
    const sheetVariables = onSheet(state?.variableNames?.());

    const checkBook = (book, label, sheet) => {
      for (const [key, entry] of book) {
        const shown = [...entry.spellings][0];

        if (entry.spellings.size > 1) {
          issues.push({
            level: "info",
            where: [...new Set([...entry.read, ...entry.written])].join("; "),
            message: `${label} written ${entry.spellings.size} ways (they count as one): ${[...entry.spellings].map(s => `"${s}"`).join(", ")}.`
          });
        }

        if (entry.read.length && !entry.written.length) {
          const byHand = sheet.has(key);
          issues.push({
            level: byHand ? "info" : "warn",
            where: [...new Set(entry.read)].join("; "),
            message: byHand
              ? `${label} "${shown}" is tested but no event sets it. It is on the current party's sheet, so it is set by hand.`
              : `${label} "${shown}" is tested but nothing sets it: no event, and it is not on the current party's sheet. Check the spelling.`
          });
        }
      }
    };

    checkBook(switches, "Switch", sheetSwitches);
    checkBook(variables, "Variable", sheetVariables);

    const count = (level) => issues.filter(i => i.level === level).length;
    const summary = {
      scenes: scenes.length,
      events: eventCount,
      errors: count("error"),
      warnings: count("warn"),
      notes: count("info")
    };

    console.log(INSTALL_TAG, "Event lint:", summary);
    if (issues.length) console.table(issues);

    return { ok: summary.errors === 0 && summary.warnings === 0, summary, issues };
  }

  window.oni.EventSystem.Lint = { installed: true, runEventLint };

  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint || {};
  globalThis.FUCompanion.api.lint.runEventLint = runEventLint;

  console.debug(INSTALL_TAG, "Installed. API: FUCompanion.api.lint.runEventLint()");
})();
