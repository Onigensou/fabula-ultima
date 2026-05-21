// ============================================================================
// Camp Activity — Magic Lesson
// Target: One ally
//
// Minigame:
//   Teacher rolls INS+WLP, target rolls WLP+INS (both silent via CheckRequester).
//   The proximity of the two totals determines spell usages (1–3) granted to
//   the target as a "may cast" Active Effect (campRestCharges: 1).
//
// Usages formula (|teacher − target| → usages):
//   exact 0  → 3 (perfect resonance) | 1–3  → 2 | 4+  → 1
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][MagicLesson]";

  const LESSON_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Aisha/EM.png";

  // ---------------------------------------------------------------------------
  // Usages formula: exact match → 3, close (diff 1–3) → 2, far → 1
  // ---------------------------------------------------------------------------
  function _calcUsages(teacherTotal, targetTotal) {
    const d = Math.abs(teacherTotal - targetTotal);
    if (d === 0) return 3;
    if (d <= 3) return 2;
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Resolve teacher's spell list (offensive + normal, deduped, item-resolved)
  // ---------------------------------------------------------------------------
  async function _resolveTeacherSpells(actor) {
    const p = actor?.system?.props ?? {};
    const entries = [
      ...Object.values(p.offensive_spell_list ?? {}),
      ...Object.values(p.normal_spell_list    ?? {}),
    ].filter(e => e && !e.$deleted && e.uuid);

    const seen = new Set();
    const spells = [];
    for (const e of entries) {
      if (seen.has(e.uuid)) continue;
      seen.add(e.uuid);
      try {
        const item = await fromUuid(e.uuid);
        if (!item) continue;
        spells.push({ name: item.name, img: item.img || "icons/svg/explosion.svg", uuid: item.uuid, isOffensive: !!item.system?.props?.isOffensiveSpell });
      } catch { /* skip unresolvable */ }
    }
    return spells;
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("magic_lesson", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Resolve party; build allies list (exclude teacher)
        const party = await CAMP.Party.resolve();
        const allies = party
          .filter(e => e.actorId !== actor.id)
          .map(e => ({
            id:   e.actorId,
            name: e.actor.name,
            img:  _getTokenImg(e.actor),
          }));

        if (!allies.length) {
          ui.notifications?.warn("Magic Lesson: no other party members to teach.");
          return;
        }

        // 2 — Broadcast START; GM sees it directly
        CAMP.Socket.broadcast(CAMP.MSG.MAGIC_LESSON_START, {
          actorId:   actor.id,
          actorName: actor.name,
          allies,
        });
        CAMP.MagicLessonUI?.show(actor.id, allies);

        await new Promise(r => setTimeout(r, 300));

        // 3 — Wait for owner to pick a target
        const targetActorId = await _waitForTarget(actor);
        const targetActor   = game.actors?.get(targetActorId);
        if (!targetActor) {
          console.warn(TAG, "Target actor not found:", targetActorId);
          return;
        }

        // 4 — Resolve teacher's spell list on GM side, broadcast for spell-pick stage
        const spells = await _resolveTeacherSpells(actor);
        if (!spells.length) {
          ui.notifications?.warn("Magic Lesson: teacher has no spells.");
          return;
        }

        CAMP.Socket.broadcast(CAMP.MSG.MAGIC_LESSON_RESULT, {
          actorId:       actor.id,
          targetActorId,
          spells,
        });
        CAMP.MagicLessonUI?.showSpellPick(actor.id, targetActorId, spells);

        await new Promise(r => setTimeout(r, 300));

        // 5 — Wait for owner to pick a spell
        const { spellUuid, spellName, spellImg } = await _waitForSpell(actor);
        const _spellItem = spellUuid ? await fromUuid(spellUuid).catch(() => null) : null;
        const spellIsOffensive = !!_spellItem?.system?.props?.isOffensiveSpell;

        // 6 — Broadcast rolling phase
        CAMP.Socket.broadcast(CAMP.MSG.MAGIC_LESSON_RESULT, {
          actorId:       actor.id,
          targetActorId,
          spellName,
          spellImg,
        });
        CAMP.MagicLessonUI?.showRolling(actor.id, targetActorId, spellName, spellImg);

        // 7 — Silent rolls (GM-side): teacher INS+WLP, target WLP+INS
        const CR = globalThis.ONI?.CheckRequester;
        let teacherTotal, targetTotal;
        if (CR) {
          const [tr, tg] = await Promise.all([
            CR.requestOne(actor,       { mode: "silent", attrA: "INS", attrB: "WLP", postChat: false }),
            CR.requestOne(targetActor, { mode: "silent", attrA: "WLP", attrB: "INS", postChat: false }),
          ]);
          teacherTotal = tr?.total ?? 0;
          targetTotal  = tg?.total ?? 0;
        } else {
          console.warn(TAG, "CheckRequester not available — using raw Roll fallback.");
          const rollTwo = async (attr1, attr2, a) => {
            const props = a.system?.props ?? {};
            const dA = parseInt(props[`${attr1.toLowerCase()}_current`]) || 8;
            const dB = parseInt(props[`${attr2.toLowerCase()}_current`]) || 8;
            const rA = (await (new Roll(`1d${dA}`)).evaluate()).total;
            const rB = (await (new Roll(`1d${dB}`)).evaluate()).total;
            return rA + rB;
          };
          [teacherTotal, targetTotal] = await Promise.all([
            rollTwo("INS", "WLP", actor),
            rollTwo("WLP", "INS", targetActor),
          ]);
        }

        await new Promise(r => setTimeout(r, 800));

        // 8 — Compute usages
        const usages = _calcUsages(teacherTotal, targetTotal);
        console.debug(TAG, `Teacher: ${teacherTotal}, Target: ${targetTotal}, Usages: ${usages}`);

        // 9 — Broadcast full result; GM applies directly
        CAMP.Socket.broadcast(CAMP.MSG.MAGIC_LESSON_RESULT, {
          actorId:       actor.id,
          targetActorId,
          spellName,
          spellImg,
          teacherTotal,
          targetTotal,
          usages,
        });
        CAMP.MagicLessonUI?.applyResult(actor.id, targetActorId, spellName, spellImg, teacherTotal, targetTotal, usages);

        // Register the proceed resolver NOW — before async AE work — so a fast
        // click (e.g. on "Perfect resonance!") cannot race ahead of _waitForProceed.
        const _proceedGate = _waitForProceed(actor);

        // 10 — Apply AE to target (remove stale one for the same spell first)
        const existing = targetActor.effects.find(
          e => e.flags?.[MODULE_ID]?.magicLessonSpell === true &&
               e.flags?.[MODULE_ID]?.spellUuid === spellUuid
        );
        if (existing) await existing.delete();

        await targetActor.createEmbeddedDocuments("ActiveEffect", [{
          name:        `Magic Lesson — ${spellName}`,
          img:         LESSON_ICON,
          description: `Once before the next rest, ${targetActor.name} may cast ${spellName} (up to ${usages} time${usages > 1 ? "s" : ""}).`,
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:          1,
              magicLessonSpell:         true,
              spellUuid,
              spellName,
              spellImg,
              spellIsOffensive,
              usagesLeft:               usages,
              magicLessonTeacherId:     actor.id,
            },
          },
        }]);

        // 11 — Chat announcement
        await _postChatResult(actor, targetActor, spellName, spellImg, teacherTotal, targetTotal, usages);

        // 12 — Wait for owner to click "Click to Proceed" (resolver was registered at step 9)
        await _proceedGate;

        // 13 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.MAGIC_LESSON_DONE, { actorId: actor.id });
        CAMP.MagicLessonUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // _waitForTarget — GM awaits owner's target selection
  // ---------------------------------------------------------------------------
  function _waitForTarget(actor) {
    return new Promise(resolve => {
      CAMP.MagicLessonUI ??= {};
      CAMP.MagicLessonUI.targetResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.MagicLessonUI.targetResolvers[actor.id]) {
          console.warn(TAG, "Target timeout — auto-picking first ally for", actor.name);
          delete CAMP.MagicLessonUI.targetResolvers[actor.id];
          CAMP.Party.resolve().then(p => {
            const ally = p.find(e => e.actorId !== actor.id);
            resolve(ally?.actorId ?? "");
          });
        }
      }, 60_000);

      CAMP.MagicLessonUI.targetResolvers[actor.id] = (targetActorId) => {
        clearTimeout(timer);
        resolve(targetActorId);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForSpell — GM awaits owner's spell selection
  // ---------------------------------------------------------------------------
  function _waitForSpell(actor) {
    return new Promise(resolve => {
      CAMP.MagicLessonUI ??= {};
      CAMP.MagicLessonUI.spellResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.MagicLessonUI.spellResolvers[actor.id]) {
          console.warn(TAG, "Spell timeout — auto-picking first spell for", actor.name);
          delete CAMP.MagicLessonUI.spellResolvers[actor.id];
          _resolveTeacherSpells(actor).then(spells => {
            const first = spells[0];
            resolve(first
              ? { spellUuid: first.uuid, spellName: first.name, spellImg: first.img }
              : { spellUuid: "", spellName: "Unknown Spell", spellImg: "" }
            );
          });
        }
      }, 60_000);

      CAMP.MagicLessonUI.spellResolvers[actor.id] = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // _waitForProceed — GM awaits owner's "Click to Proceed"
  // ---------------------------------------------------------------------------
  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.MagicLessonUI ??= {};
      CAMP.MagicLessonUI.proceedResolvers ??= {};
      CAMP.MagicLessonUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Token image helper
  // ---------------------------------------------------------------------------
  function _getTokenImg(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(teacher, target, spellName, spellImg, teacherTotal, targetTotal, usages) {
    const usageColor = usages >= 3 ? "#c8a84b" : usages >= 2 ? "#3a7a35" : "#7a5010";
    const spellIconSrc = spellImg || LESSON_ICON;

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${LESSON_ICON}" style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${teacher.name} — Magic Lesson
            </div>
            <div style="font-size:.88em;margin-top:3px;">
              Teaching <strong>${target.name}</strong> the spell
              <img src="${spellIconSrc}" style="width:16px;height:16px;vertical-align:middle;border:none;border-radius:3px;margin:0 2px;">
              <strong>${spellName}</strong>
            </div>
            <div style="font-size:.85em;margin-top:3px;opacity:.85;">
              ${teacher.name} rolled <strong>${teacherTotal}</strong> &nbsp;&middot;&nbsp;
              ${target.name} rolled <strong>${targetTotal}</strong>
            </div>
            <div style="font-size:.9em;margin-top:4px;font-weight:700;color:${usageColor};">
              ${usages} use${usages > 1 ? "s" : ""} granted
            </div>
            <div style="font-size:.8em;margin-top:3px;opacity:.7;font-style:italic;">
              ${target.name} may cast ${spellName} up to ${usages} time${usages > 1 ? "s" : ""} before the next rest.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-ml-chat-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display:none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top:6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin:0 !important; }
      `;
      document.head.appendChild(style);
    }
  }

  console.debug(TAG, "Magic Lesson activity loaded.");
})();
