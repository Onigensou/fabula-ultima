/**
 * Macro: Equipment
 * Id: AabVSlOGS5hFOfpr
 * Folder: Command Buttons
 * Type: script
 * Author: GM
 *
 * Stabilized armor support (text-field style):
 * - Shows Armor dropdown only when NOT in active combat on the current scene.
 * - On confirm, updates actor equipment fields under system.props (same pattern as weapons/accessories).
 * - Also toggles system.props.isEquipped for:
 *    - Armor (the selected armor, when allowed)
 *    - Hand equipment (weapons + shields, based on Main/Off hand selections)
 *    - Accessories (based on Accessory/Accessory2 selections)
 * - NEW: also toggles embedded Active Effects on equipped items ON/OFF
 *   so equipment-granted bonus stats stay in sync with equip state.
 *
 * Commit order:
 *   1) actor.updateEmbeddedDocuments('Item', ...)   (isEquipped toggles)
 *   2) ownedItem.updateEmbeddedDocuments('ActiveEffect', ...) (AE disabled toggles)
 *   3) actor.update(...)                            (display fields)
 */

(async () => {
  // ───────────────────────────────────────────────────────────
  //  Fabula Ultima • Change Equipment (User-linked version)
  // ───────────────────────────────────────────────────────────

  /* -------------------------------------------------------
   * 0. Debug override (optional)
   * ----------------------------------------------------- */
  const DEBUG_CHARACTER_NAME = ""; // ← put an actor name here to force-test
  const DEBUG = false;
  const DBG = (...a) => DEBUG && console.log("[ONI][Equip]", ...a);

  const UNARM_STRIKE_ITEM_ID = "bwqZvS4NXw7bCrmV";
  const blipSound = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  const confirmSound = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Key.ogg";

  const unarmStrike = game.items.get(UNARM_STRIKE_ITEM_ID);
  if (!unarmStrike) {
    ui.notifications.error("[Equipment] Unarmed Strike item not found. Check UNARM_STRIKE_ITEM_ID.");
    return;
  }

  const emptyAccessory = { system: { props: { name: "No accessory", description: "" } } };

  /* -------------------------------------------------------
   * 1. Resolve actor & token for the invoking user
   * ----------------------------------------------------- */
  let actor = null;
  let tkn = null;

  if (DEBUG_CHARACTER_NAME) {
    actor = game.actors.getName(DEBUG_CHARACTER_NAME);
    if (!actor) return ui.notifications.error(`DEBUG: Actor "${DEBUG_CHARACTER_NAME}" not found.`);
  } else {
    const user = game.user;
    actor = user.character ?? null; // User → Character link

    // fallback: first controlled token
    if (!actor) {
      tkn = canvas?.tokens?.controlled?.[0] ?? null;
      actor = tkn?.actor ?? null;
    }

    if (!actor) {
      ui.notifications.error("You don’t have a linked character or any controlled tokens.");
      return;
    }
  }

  // Optional: find on-scene token by actor ID (we do NOT require it)
  if (!tkn) {
    tkn = canvas?.scene?.tokens?.find(tok => tok.actor?.id === actor.id) ?? null;
  }

  /* -------------------------------------------------------
   * 2. Detect if combat is currently active on THIS scene
   *    (Armor swap is only allowed when NOT in combat)
   * ----------------------------------------------------- */
  const getCombatStateOnActiveScene = () => {
    const activeScene = canvas?.scene ?? null;
    const activeSceneId = activeScene?.id ?? null;

    const combats = game.combats?.contents ?? [];
    const matches = activeSceneId ? combats.filter(c => c.scene?.id === activeSceneId) : [];

    const picked =
      matches.find(c => (typeof c.started === "boolean" ? c.started : Number(c.round ?? 0) > 0)) ??
      matches.find(c => (typeof c.active === "boolean" ? c.active : false)) ??
      matches.find(c => (c.combatants?.size ?? 0) > 0) ??
      null;

    return { hasCombat: !!picked, combat: picked, activeSceneId };
  };

  const { hasCombat } = getCombatStateOnActiveScene();
  const showArmorField = !hasCombat;

  /* -------------------------------------------------------
   * 3. Gather equipment from the actor inventory
   * ----------------------------------------------------- */
  const carryingWeapons = actor.items.filter(i => i?.system?.props?.item_type === "weapon");
  const carryingShields = actor.items.filter(i => i?.system?.props?.item_type === "shield");
  const carryingAccessory = actor.items.filter(i => i?.system?.props?.item_type === "accessory");
  const carryingArmor = actor.items.filter(i => i?.system?.props?.item_type === "armor");
  const carryingHandEquip = [...carryingWeapons, ...carryingShields];

  // Current equipped items (with graceful fallbacks)
  const curMainIdx = carryingHandEquip.findIndex(i => i.system.props.name === actor.system.props.main_hand);
  const curOffIdx = carryingHandEquip.findIndex(i => i.system.props.name === actor.system.props.off_hand);
  const curAccIdx = carryingAccessory.findIndex(i => i.system.props.name === actor.system.props.accessory_name);
  const curAcc2Idx = carryingAccessory.findIndex(i => i.system.props.name === actor.system.props.accessory2_name);

  // Armor uses its own toggle flag: system.props.isEquipped
  const curArmorIdx = carryingArmor.findIndex(i => i?.system?.props?.isEquipped === true);

  const curMainHand = curMainIdx >= 0 ? carryingHandEquip[curMainIdx] : unarmStrike;
  const curOffHand = curOffIdx >= 0 ? carryingHandEquip[curOffIdx] : unarmStrike;
  const curAcc = curAccIdx >= 0 ? carryingAccessory[curAccIdx] : emptyAccessory;
  const curAcc2 = curAcc2Idx >= 0 ? carryingAccessory[curAcc2Idx] : emptyAccessory;
  const curArmor = curArmorIdx >= 0 ? carryingArmor[curArmorIdx] : null;

  /* -------------------------------------------------------
   * 3.5. Active Effect sync helpers
   * ----------------------------------------------------- */
  const unpackContainer = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return Object.values(value);
    return [];
  };

  const getConfiguredItemEffectRefs = (item) => {
    return [
      ...unpackContainer(item?.system?.props?.item_activeEffect),
      ...unpackContainer(item?.system?.item_activeEffect),
      ...unpackContainer(item?.item_activeEffect)
    ].filter(Boolean);
  };

  const findOwnedEffectMatch = (item, ref) => {
    const all = item?.effects?.contents ?? [];
    if (!all.length || !ref) return null;

    const directId = ref._id ?? ref.id ?? null;
    if (directId && item.effects?.get(directId)) {
      return item.effects.get(directId);
    }

    const refFlags = ref.flags?.["custom-system-builder"] ?? {};
    const refOriginalId = refFlags.originalId ?? ref.originalId ?? null;
    const refOriginalUuid = refFlags.originalUuid ?? ref.originalUuid ?? null;

    if (refOriginalId) {
      const byOriginalId = all.find(fx =>
        (fx.flags?.["custom-system-builder"]?.originalId ?? null) === refOriginalId
      );
      if (byOriginalId) return byOriginalId;
    }

    if (refOriginalUuid) {
      const byOriginalUuid = all.find(fx =>
        (fx.flags?.["custom-system-builder"]?.originalUuid ?? null) === refOriginalUuid
      );
      if (byOriginalUuid) return byOriginalUuid;
    }

    const refName = String(ref.name ?? "").trim().toLowerCase();
    if (refName) {
      const byName = all.find(fx => String(fx.name ?? "").trim().toLowerCase() === refName);
      if (byName) return byName;
    }

    return null;
  };

  const resolveEquipmentEffectDocs = (item) => {
    const ownedEffects = item?.effects?.contents ?? [];
    if (!ownedEffects.length) return [];

    // Prefer the configured item_activeEffect list if it exists.
    const configuredRefs = getConfiguredItemEffectRefs(item);
    if (!configuredRefs.length) {
      return ownedEffects;
    }

    const out = new Map();
    for (const ref of configuredRefs) {
      const live = findOwnedEffectMatch(item, ref);
      if (live) out.set(live.id, live);
    }

    // Fallback: if configured refs did not resolve cleanly, just use all owned item effects.
    return out.size ? [...out.values()] : ownedEffects;
  };

  const activeEffectUpdateMap = new Map(); // itemId -> Map(effectId -> update)

  const addActiveEffectUpdate = (itemId, effectId, patch) => {
    if (!itemId || !effectId) return;
    if (!activeEffectUpdateMap.has(itemId)) activeEffectUpdateMap.set(itemId, new Map());

    const bucket = activeEffectUpdateMap.get(itemId);
    const existing = bucket.get(effectId) ?? { _id: effectId };
    Object.assign(existing, patch);
    bucket.set(effectId, existing);
  };

  const queueItemEffectState = (item, shouldEnable) => {
    if (!item?.id) return;

    const effectDocs = resolveEquipmentEffectDocs(item);
    if (!effectDocs.length) return;

    const desiredDisabled = !shouldEnable;

    for (const fx of effectDocs) {
      if (!!fx.disabled === desiredDisabled) continue;
      addActiveEffectUpdate(item.id, fx.id, { disabled: desiredDisabled });
    }
  };

  /* -------------------------------------------------------
   * 4. Build and show the equipment dialog
   * ----------------------------------------------------- */
  try {
    if (typeof Sequence !== "undefined") new Sequence().sound(blipSound).volume(1).play();
    else AudioHelper.play({ src: blipSound, volume: 0.5, autoplay: true });
  } catch (e) {}

  const armorFieldHtml = showArmorField ? `
    <div class='form-group'><label>Armor:</label>
      <select id='armorSelector'>
        <option value='-1' style='color:gray'>No Armor</option>
        ${carryingArmor
          .map((it, i) => `<option value='${i}' ${i === curArmorIdx ? "selected" : ""}>${it.system.props.name}</option>`)
          .join("")}
      </select>
    </div>
  ` : ``;

  const dlg = new Dialog({
    title: "Fabula Ultima – Equipment Action",
    content: `
      <form>
        <!-- Main Hand -->
        <div class='form-group'><label>Main Hand:</label>
          <select id='mainHandSelector'>
            <option value='-1' style='color:gray'>Empty Hand</option>
            <optgroup label="Weapons">
              ${carryingWeapons
                .map((it, i) => `<option value='${i}' ${i === curMainIdx ? "selected" : ""}>${it.system.props.name}</option>`)
                .join("")}
            </optgroup>
            <optgroup label="Shields">
              ${carryingShields
                .map((it, i) => {
                  const idx = i + carryingWeapons.length;
                  return `<option value='${idx}' ${idx === curMainIdx ? "selected" : ""}>${it.system.props.name}</option>`;
                })
                .join("")}
            </optgroup>
          </select>
        </div>

        <!-- Off Hand -->
        <div class='form-group'><label>Off Hand:</label>
          <select id='offHandSelector'>
            <option value='-1' style='color:gray'>Empty Hand</option>
            <optgroup label="Weapons">
              ${carryingWeapons
                .map((it, i) => `<option value='${i}' ${i === curOffIdx ? "selected" : ""}>${it.system.props.name}</option>`)
                .join("")}
            </optgroup>
            <optgroup label="Shields">
              ${carryingShields
                .map((it, i) => {
                  const idx = i + carryingWeapons.length;
                  return `<option value='${idx}' ${idx === curOffIdx ? "selected" : ""}>${it.system.props.name}</option>`;
                })
                .join("")}
            </optgroup>
          </select>
        </div>

        ${armorFieldHtml}

        <!-- Accessories -->
        <div class='form-group'><label>Accessory:</label>
          <select id='accessorySelector'>
            <option value='-1' style='color:gray'>No Accessory</option>
            ${carryingAccessory
              .map((it, i) => `<option value='${i}' ${i === curAccIdx ? "selected" : ""}>${it.system.props.name}</option>`)
              .join("")}
          </select>
        </div>

        <div class='form-group'><label>Accessory 2:</label>
          <select id='accessory2Selector'>
            <option value='-1' style='color:gray'>No Accessory</option>
            ${carryingAccessory
              .map((it, i) => `<option value='${i}' ${i === curAcc2Idx ? "selected" : ""}>${it.system.props.name}</option>`)
              .join("")}
          </select>
        </div>
      </form>
    `,
    render: html => html.find("select").on("change", () => {
      try { AudioHelper.play({ src: blipSound, volume: 0.5, autoplay: true }); } catch (e) {}
    }),
    buttons: {
      confirm: {
        label: "<b>Confirm</b>",
        callback: async html => {
          // ---- read selections ----
          const newMainIdx = Number(html.find("#mainHandSelector").val());
          const newOffIdx = Number(html.find("#offHandSelector").val());
          const newAccIdx = Number(html.find("#accessorySelector").val());
          const newAcc2Idx = Number(html.find("#accessory2Selector").val());

          // Armor selector only exists when showArmorField is true
          const armorSelectorEl = html.find("#armorSelector");
          const newArmorIdx = (showArmorField && armorSelectorEl?.length) ? Number(armorSelectorEl.val()) : null;

          let resultMsg = "";
          const updates = {};

          // We'll collect embedded Item updates in a map to avoid duplicate _id entries.
          const embeddedItemUpdateMap = new Map();
          const addEmbeddedUpdate = (id, path, value) => {
            if (!id) return;
            const existing = embeddedItemUpdateMap.get(id) ?? { _id: id };
            existing[path] = value;
            embeddedItemUpdateMap.set(id, existing);
          };

          // ---- helper to process hand change ----
          const applyHand = ({ slotName, curIdx, newIdx, curItem, list, isMain }) => {
            if (curIdx === newIdx) return;

            const newItem = newIdx >= 0 ? list[newIdx] : unarmStrike;
            const isWeapon = newItem?.system?.props?.item_type === "weapon";
            const icon = isWeapon ? "⚔️" : "🛡️";

            resultMsg += `${resultMsg ? "<hr>" : ""}
              <p>${slotName} Hand:</p>
              <p>
                <span>${curItem?.system?.props?.item_type === "weapon" ? "⚔️" : "🛡️"} </span>
                <span style="color:gray">${curItem.system.props.name}</span> ⮞
                <span>${icon}</span> <span style="color:red">${newItem.system.props.name}</span>
              </p>`;

            if (isMain) {
              updates["system.props.main_hand"] = newItem.system.props.name;
              updates["system.props.main_attrib_1"] = isWeapon ? newItem.system.props.rolled_atr1 : "SHI";
              updates["system.props.main_attrib_2"] = isWeapon ? newItem.system.props.rolled_atr2 : "SHI";
              updates["system.props.weapon1_base_mod"] = isWeapon ? newItem.system.props.check_bonus : newItem.system.props.item_def_bonus;
              updates["system.props.weapon1_base_damage"] = isWeapon ? newItem.system.props.damage_bonus : newItem.system.props.item_mdef_bonus;
              updates["system.props.weapon1_damagetype"] = isWeapon ? newItem.system.props.type_damage : "-";
              updates["system.props.main_details"] = newItem.system.props.description;
            } else {
              updates["system.props.off_hand"] = newItem.system.props.name;
              updates["system.props.off_attrib_1"] = isWeapon ? newItem.system.props.rolled_atr1 : "SHI";
              updates["system.props.off_attrib_2"] = isWeapon ? newItem.system.props.rolled_atr2 : "SHI";
              updates["system.props.off_base_mod_1"] = isWeapon ? newItem.system.props.check_bonus : newItem.system.props.item_def_bonus;
              updates["system.props.off_base_mod_2"] = isWeapon ? newItem.system.props.damage_bonus : newItem.system.props.item_mdef_bonus;
              updates["system.props.weapon2_damagetype"] = isWeapon ? newItem.system.props.type_damage : "-";
              updates["system.props.off_details"] = newItem.system.props.description;
            }
          };

          // ---- main / off hand ----
          applyHand({ slotName: "Main", curIdx: curMainIdx, newIdx: newMainIdx, curItem: curMainHand, list: carryingHandEquip, isMain: true });
          applyHand({ slotName: "Off", curIdx: curOffIdx, newIdx: newOffIdx, curItem: curOffHand, list: carryingHandEquip, isMain: false });

          // ---- desired equipped sets ----
          const desiredHandIds = new Set();
          const selMainHand = (newMainIdx >= 0) ? carryingHandEquip[newMainIdx] : null;
          const selOffHand = (newOffIdx >= 0) ? carryingHandEquip[newOffIdx] : null;
          if (selMainHand?.id) desiredHandIds.add(selMainHand.id);
          if (selOffHand?.id) desiredHandIds.add(selOffHand.id);

          const desiredAccIds = new Set();
          const selAcc = (newAccIdx >= 0) ? carryingAccessory[newAccIdx] : null;
          const selAcc2 = (newAcc2Idx >= 0) ? carryingAccessory[newAcc2Idx] : null;
          if (selAcc?.id) desiredAccIds.add(selAcc.id);
          if (selAcc2?.id) desiredAccIds.add(selAcc2.id);

          const desiredArmorId = showArmorField
            ? ((typeof newArmorIdx === "number" && newArmorIdx >= 0) ? carryingArmor[newArmorIdx]?.id ?? null : null)
            : (curArmor?.id ?? null);

          // ---- hand equipment isEquipped toggles + Active Effect sync ----
          {
            for (const item of carryingHandEquip) {
              const cur = !!item.system?.props?.isEquipped;
              const next = desiredHandIds.has(item.id);

              if (cur !== next) {
                addEmbeddedUpdate(item.id, "system.props.isEquipped", next);
              }

              queueItemEffectState(item, next);
            }
          }

          // ---- armor (only outside battle for selector / actor display changes) ----
          if (showArmorField && typeof newArmorIdx === "number") {
            if (curArmorIdx !== newArmorIdx) {
              const newArmor = (newArmorIdx >= 0) ? carryingArmor[newArmorIdx] : null;

              resultMsg += `${resultMsg ? "<hr>" : ""}
                <p>Armor:</p>
                <p>
                  <span style="color:gray">🥋 ${curArmor?.system?.props?.name ?? "No Armor"}</span> ⮞
                  <span style="color:red">🥋 ${newArmor?.system?.props?.name ?? "No Armor"}</span>
                </p>`;

              // Update actor sheet armor fields (mirrors weapon/accessory pattern)
              if (!newArmor) {
                updates["system.props.armor_name"] = "";
                updates["system.props.armor_mod"] = 0;
                updates["system.props.is_martialarmor"] = false;
                updates["system.props.magic_defense_mod"] = 0;
                updates["system.props.init_penalty"] = 0;
                updates["system.props.armor_details"] = "";
              } else {
                const a = newArmor.system?.props ?? {};
                const isMartial = !!a.isMartial;

                const armorMod = Number(isMartial ? (a.item_baseDef ?? 0) : (a.item_def_bonus ?? 0)) || 0;
                const mdefMod = Number(isMartial ? (a.item_baseMdef ?? 0) : (a.item_mdef_bonus ?? 0)) || 0;
                const initPenalty = Number(a.init_penalty ?? a.item_init_penalty ?? a.initiative_penalty ?? 0) || 0;
                const details = String(a.description ?? "");

                updates["system.props.armor_name"] = a.name ?? newArmor.name ?? "";
                updates["system.props.armor_mod"] = armorMod;
                updates["system.props.is_martialarmor"] = isMartial;
                updates["system.props.magic_defense_mod"] = mdefMod;
                updates["system.props.init_penalty"] = initPenalty;
                updates["system.props.armor_details"] = details;
              }
            }
          }

          // ---- armor isEquipped toggles + Active Effect sync ----
          {
            for (const armor of carryingArmor) {
              const cur = !!armor.system?.props?.isEquipped;
              const next = armor.id === desiredArmorId;

              if (showArmorField && cur !== next) {
                addEmbeddedUpdate(armor.id, "system.props.isEquipped", next);
              }

              queueItemEffectState(armor, next);
            }
          }

          // ---- accessories ----
          const accSlots = [
            { curIdx: curAccIdx, newIdx: newAccIdx, curItem: curAcc, propName: "accessory", label: "Accessory" },
            { curIdx: curAcc2Idx, newIdx: newAcc2Idx, curItem: curAcc2, propName: "accessory2", label: "Accessory 2" }
          ];

          for (const slot of accSlots) {
            if (slot.curIdx === slot.newIdx) continue;
            const newItem = slot.newIdx >= 0 ? carryingAccessory[slot.newIdx] : emptyAccessory;

            resultMsg += `${resultMsg ? "<hr>" : ""}
              <p>${slot.label}:</p>
              <p><span style="color:gray">🔮 ${slot.curItem.system.props.name}</span> ⮞
                 <span style="color:red">🔮 ${newItem.system.props.name}</span></p>`;

            updates[`system.props.${slot.propName}_name`] = newItem.system.props.name;
            updates[`system.props.${slot.propName}_details`] = newItem.system.props.description;
          }

          // ---- accessory isEquipped toggles + Active Effect sync ----
          {
            for (const a of carryingAccessory) {
              const cur = !!a.system?.props?.isEquipped;
              const next = desiredAccIds.has(a.id);

              if (cur !== next) {
                addEmbeddedUpdate(a.id, "system.props.isEquipped", next);
              }

              queueItemEffectState(a, next);
            }
          }

          // ---- commit & announce ----
          if (!resultMsg) return; // nothing changed from the user's visible selection

          const hasActorUpdates = Object.keys(updates).length > 0;
          const embeddedItemUpdates = Array.from(embeddedItemUpdateMap.values());
          const hasItemUpdates = embeddedItemUpdates.length > 0;

          const activeEffectUpdateEntries = [...activeEffectUpdateMap.entries()]
            .map(([itemId, fxMap]) => ({
              item: actor.items.get(itemId),
              updates: [...fxMap.values()]
            }))
            .filter(entry => entry.item && entry.updates.length > 0);

          const hasEffectUpdates = activeEffectUpdateEntries.length > 0;

          // IMPORTANT: items first, effects second, actor third
          if (hasItemUpdates) {
            DBG("Applying embedded item updates first", embeddedItemUpdates);
            await actor.updateEmbeddedDocuments("Item", embeddedItemUpdates);
          }

          if (hasEffectUpdates) {
            for (const entry of activeEffectUpdateEntries) {
              DBG("Applying active effect toggles", {
                item: entry.item.name,
                updates: entry.updates
              });
              await entry.item.updateEmbeddedDocuments("ActiveEffect", entry.updates);
            }
          }

          if (hasActorUpdates) {
            DBG("Applying actor updates third", updates);
            await actor.update(updates);
          }

          // Refresh sheets (best-effort)
          try { actor.render?.(true); } catch (e) {}
          try {
            for (const app of Object.values(actor.apps ?? {})) {
              try { app.render(true); } catch (e) {}
            }
          } catch (e) {}

          try { AudioHelper.play({ src: confirmSound, volume: 0.5, autoplay: true }); } catch (e) {}

          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<h2>Equipment Change!</h2>${resultMsg}`
          });
        }
      },
      cancel: { label: "Cancel" }
    }
  });

  dlg.render(true);
})();
