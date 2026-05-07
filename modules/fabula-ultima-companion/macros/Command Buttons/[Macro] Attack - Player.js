// ───────────────────────────────────────────────────────────
//  Fabula Ultima • Attack (Old-look → New-flow) · Foundry V12
//  - Keeps Old_Attack UI (sound, tooltips, layout)
//  - No chat card here; forwards to ActionDataFetch
//  - Damage Type auto-defaults to weapon’s type (resyncs on weapon change)
//  - UPDATE: also forwards weapon_type to ActionDataFetch (weapon_list.weapon_type)
//  - UPDATE: forwards skill_target="-" so JRPG Targeting API uses Free Mode
// ───────────────────────────────────────────────────────────
async function fabulaUltimaAttack() {
  /* -------------------------------------------------------
  * 0. Helpers & constants (unchanged UI bits)
  * ----------------------------------------------------- */
  const generateDetailBuffHoverBox = (buffs) => {
    let buffTexts = (buffs || []).filter(b => b !== undefined)
      .map(buff => `${(Number(buff?.value) ?? 0) >= 0 ? '+' : '-'} ${buff.value} (${buff.name})`);
    return buffTexts.join("<br/>");
  };

  const damageTypes = ["Physical","Fire","Ice","Bolt","Air","Earth","Poison","Light","Dark"];
  
  // v0.2 — Dual Shieldbearer helpers
  const DSB_BASE_UUID = "Item.TwiggXCPpT07L0OR";
  const TWIN_UUID     = "Item.uENFXqIkJf5MeART";
  const _norm = (v) => (v ?? "").toString().trim().toLowerCase();
  const _gp = (obj, path) => { try { return foundry?.utils?.getProperty?.(obj, path); } catch { return undefined; } };
  function _uuidCandidates(it) {
    return [ it?.uuid, it?.sourceId, _gp(it,"sourceId"), _gp(it,"flags.core.sourceId"), _gp(it,"flags.core.uuid"), _gp(it,"_stats.compendiumSource") ].filter(Boolean).map(String);
  }
  function _matchesBaseUuid(cands, baseUuid) {
    const baseId = String(baseUuid).split(".").pop();
    return cands.some(u => u === baseUuid || u.endsWith(`.${baseId}`) || u.includes(`.${baseId}`));
  }
  function hasDualShieldbearer(actor) {
    try {
      const items = Array.from(actor?.items ?? []);
      if (items.some(it => _matchesBaseUuid(_uuidCandidates(it), DSB_BASE_UUID))) return true;
      return items.some(it => _norm(it?.name) === "dual shieldbearer");
    } catch { return false; }
  }
  function isShieldEntry(entry) {
    const t = _norm(entry?.weapon_type || entry?.category);
    return t === "shield";
  }
  function isShieldByAttrKeys(actor, which) {
    const key = which === "off" ? "off_attrib_1" : "main_attrib_1";
    return String(_gp(actor, `system.props.${key}`) ?? "").toUpperCase() === "SHI";
  }
  async function buildTwinShieldWeaponRow() {
    try {
      const doc = await fromUuid(TWIN_UUID);
      if (!doc) return null;
      const GP = (k, d = "") => _gp(doc, `system.props.${k}`) ?? d;
      const attrib1       = (GP("rolled_atr1","MIG") || "MIG").toUpperCase();
      const attrib2       = (GP("rolled_atr2","MIG") || "MIG").toUpperCase();
      const accuracyBonus = Number(GP("check_bonus", 0)) || 0;
      const damage        = Number(GP("damage_bonus", 0)) || 0;
      const damageType    = GP("type_damage","Physical") || "Physical";
      const weaponRange   = GP("weapon_range", GP("skill_range","Melee")) || "Melee";
      const weaponType    = GP("weapon_type", GP("category",""));
      return { name: doc.name || "Twin Shield", attrib1, attrib2, accuracyBonus, damage, damageType, weaponRange, weaponType, weaponUuid: doc.uuid || null };
    } catch(e) { console.warn("[DualShieldbearer] fromUuid(TWIN_UUID) failed", e); return null; }
  }

  /* -------------------------------------------------------
   * 1. Resolve the actor & token for the user who pressed it
   * ----------------------------------------------------- */
  const user  = game.user;
  let actor   = user?.character ?? null;
  let tkn     = null;

  if (!actor) {
    tkn   = canvas.tokens.controlled[0];
    actor = tkn?.actor ?? null;
  }
  if (!actor) return ui.notifications.error("You don't have a linked character or any controlled tokens.");

  if (!tkn) {
    // v12: prefer placeables to find the rendered token for this actor
    tkn = canvas.tokens.placeables.find(tok => tok.actor?.id === actor.id);
  }
  if (!tkn) return ui.notifications.error("Your character’s token is not on the current scene.");

  /* -------------------------------------------------------
   * 2. Build weapon data from the actor sheet (as before)
   *    UPDATE: also read weapon_type from weapon_list for each weapon.
   * ----------------------------------------------------- */
  const allWeaponList = Object.values(actor.system?.props?.weapon_list || {});

  const mainHandName = actor.system?.props?.main_hand;
  const offHandName  = actor.system?.props?.off_hand;

  const mainEntry = allWeaponList.find(w => w?.name == mainHandName) ?? null;
  const offEntry  = allWeaponList.find(w => w?.name == offHandName)  ?? null;

  let weapons = [
    {
      name:        mainHandName || "Main Hand",
      attrib1:     actor.system?.props?.main_attrib_1       ?? "DEX",
      attrib2:     actor.system?.props?.main_attrib_2       ?? "DEX",
      accuracyBonus: Number(actor.system?.props?.weapon1_mod    ?? 0),
      damage:      Number(actor.system?.props?.weapon1_damage ?? 0),
      damageType:  actor.system?.props?.weapon1_damagetype  ?? "Physical",
      weaponRange: (mainEntry?.weapon_range) ?? "Melee",

      // ✅ NEW: forward weaponType from weapon_list (ex: "Bow", "Dagger", "Sword")
      weaponType : (mainEntry?.weapon_type || mainEntry?.category) ?? ""
    },
    {
      name:        offHandName || "Off-Hand",
      attrib1:     actor.system?.props?.off_attrib_1        ?? "DEX",
      attrib2:     actor.system?.props?.off_attrib_2        ?? "DEX",
      accuracyBonus: Number(actor.system?.props?.off_mod_1      ?? 0),
      damage:      Number(actor.system?.props?.off_mod_2      ?? 0),
      damageType:  actor.system?.props?.weapon2_damagetype  ?? "Physical",
      weaponRange: (offEntry?.weapon_range) ?? "Melee",

      // ✅ NEW
      weaponType : (offEntry?.weapon_type || offEntry?.category) ?? ""
    }
  ];

  weapons = weapons.filter(w => w.name && w.attrib1 !== "SHI" && w.attrib1 !== "Undefined");

  // v0.2 — Dual Shieldbearer: inject Twin Shield virtual weapon when eligible
  await (async () => {
    try {
      const mainIsShield = isShieldEntry(mainEntry) || isShieldByAttrKeys(actor, "main");
      const offIsShield  = isShieldEntry(offEntry)  || isShieldByAttrKeys(actor, "off");
      if (hasDualShieldbearer(actor) && mainIsShield && offIsShield) {
        const twin = await buildTwinShieldWeaponRow();
        if (twin) weapons.push(twin);
      }
    } catch(e) { console.warn("[DualShieldbearer] injection failed", e); }
  })();

  if (!weapons.length) return ui.notifications.warn("No weapons equipped.");

  /* -------------------------------------------------------
   * 3. Build character modifiers (same fields you used)
   * ----------------------------------------------------- */
  const extraDamageInfo = {
    all:    Number(actor.system?.props?.extra_damage_mod_all     ?? 0),
    melee:  Number(actor.system?.props?.extra_damage_mod_melee   ?? 0),
    ranged: Number(actor.system?.props?.extra_damage_mod_ranged  ?? 0),
    physical:Number(actor.system?.props?.extra_damage_mod_physical?? 0),
    air:    Number(actor.system?.props?.extra_damage_mod_air     ?? 0),
    fire:   Number(actor.system?.props?.extra_damage_mod_fire    ?? 0),
    ice:    Number(actor.system?.props?.extra_damage_mod_ice     ?? 0),
    bolt:   Number(actor.system?.props?.extra_damage_mod_bolt    ?? 0),
    dark:   Number(actor.system?.props?.extra_damage_mod_dark    ?? 0),
    light:  Number(actor.system?.props?.extra_damage_mod_light   ?? 0),
    earth:  Number(actor.system?.props?.extra_damage_mod_earth   ?? 0),
    poison: Number(actor.system?.props?.extra_damage_mod_poison  ?? 0),
  };

  const extraAccuracyInfo = {
    all:    Number(actor.system?.props?.attack_accuracy_mod_all    ?? 0),
    melee:  Number(actor.system?.props?.attack_accuracy_mod_melee  ?? 0),
    ranged: Number(actor.system?.props?.attack_accuracy_mod_ranged ?? 0),
    magic:  Number(actor.system?.props?.attack_accuracy_mod_magic  ?? 0),
  };

  // Tooltip “buffDetails” map (unchanged)
  const buffDetails = {};
  (actor.appliedEffects ?? []).forEach(effect => {
    for (const idx in (effect.changes ?? [])) {
      const change = effect.changes[idx];
      try {
        const key = new ComputablePhrase(change.key).computeStatic(effect.parent.system.props).result;
        const val = new ComputablePhrase(change.value).computeStatic(effect.parent.system.props).result;
        const entry = { name: effect.name, value: val };
        if (buffDetails[key]) buffDetails[key].push(entry);
        else buffDetails[key] = [entry];
      } catch(e) { /* silent */ }
    }
  });

  let selectedWeaponIndex = 0;
  let ignoreHR = false;

  /* -------------------------------------------------------
   * 4. Play cursor sfx + build dialog (Old UI intact)
   * ----------------------------------------------------- */
  const cursorMoveSound = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  new Sequence().sound(cursorMoveSound).volume(1).play();

  const dialogContent = `
  <form>
    <div class='form-group'>
      <label>Weapon:</label>
      <select id='weapon'>
        ${weapons.map((w, i) => `<option value='${i}' ${i === 0 ? 'selected' : ''}>${w.name}</option>`).join("")}
      </select>
    </div>
    <div class='form-group'>
      <label>Accuracy Check:</label>
      <div id="selectedWeaponAccuracy">
        <b>[${weapons[0].attrib1} + ${weapons[0].attrib2}] + ${Number(weapons[0].accuracyBonus) + Number(extraAccuracyInfo.all) + Number(extraAccuracyInfo[weapons[0].weaponRange.toLowerCase()] ?? 0)}</b>
        <span id="selectedWeaponAccuracyDetails" style="background-color: rgba(0, 0, 0, 0.60); color: #fff; text-align: center; padding: 5px 10px; margin: 0 0 0 5px; border-radius: 6px; position: absolute; z-index: 1; width: 200px">
          ${generateDetailBuffHoverBox(
            [{ name: "Weapon Accuracy", value: weapons[0].accuracyBonus }]
            .concat(buffDetails['attack_accuracy_mod_all'], buffDetails['attack_accuracy_mod_' + weapons[0].weaponRange.toLowerCase()])
          )}
        </span>
      </div>
    </div>
    <div class='form-group'>
      <label>Damage:</label>
      <div id="selectedWeaponDamage">
        <b>${ignoreHR ? '' : 'HR + '}${Number(weapons[0].damage) + Number(extraDamageInfo.all) + Number(extraDamageInfo[weapons[0].weaponRange.toLowerCase()] ?? 0) + Number(extraDamageInfo[weapons[0].damageType.toLowerCase()] ?? 0)}</b>
        <span id="selectedWeaponDamageDetails" style="background-color: rgba(0, 0, 0, 0.60); color: #fff; text-align: center; padding: 5px 10px; margin: 0 0 0 5px; border-radius: 6px; position: absolute; z-index: 1; width: 200px">
          ${generateDetailBuffHoverBox(
            [{ name: "Weapon Damage", value: weapons[0].damage }]
            .concat(buffDetails['extra_damage_mod_all'], buffDetails['extra_damage_mod_' + weapons[0].weaponRange.toLowerCase()], buffDetails['extra_damage_mod_' + weapons[0].damageType.toLowerCase()])
          )}
        </span>
      </div>
    </div>
    <div class='form-group'><label>Ignore HR:</label><input type='checkbox' id='ignoreHR'></div>
    <div class='form-group'><label>Custom Accuracy Mod:</label><input type='number' id='bonusAcc' value='0'></div>
    <div class='form-group'><label>Custom Extra Damage:</label><input type='number' id='bonusDmg' value='0'></div>
    <div class='form-group'>
      <label>Damage Type:</label>
      <select id='damageType'>
        ${damageTypes.map(type => `<option value='${type}' ${type === weapons[0].damageType ? 'selected' : ''}>${type}</option>`).join("")}
      </select>
    </div>
  </form>`;

  new Dialog({
    title: "Fabula Ultima – Attack Action",
    content: dialogContent,
    render: html => {
      // Keep your hover tooltips working (unchanged)
      html.find('#selectedWeaponAccuracyDetails').hide();
      html.find('#selectedWeaponDamageDetails').hide();

      html.find('#selectedWeaponAccuracy').hover(
        () => html.find('#selectedWeaponAccuracyDetails').show(150),
        () => html.find('#selectedWeaponAccuracyDetails').hide(150)
      );
      html.find('#selectedWeaponDamage').hover(
        () => html.find('#selectedWeaponDamageDetails').show(150),
        () => html.find('#selectedWeaponDamageDetails').hide(150)
      );

      // SFX on any change, like your old macro
      html.find('select, input').on("change input", () =>
        AudioHelper.play({ src: cursorMoveSound, volume: 0.5, autoplay: true })
      );

      // (A) Weapon change → resync damage type to weapon type (auto-default)
      html.find('#weapon').on("change", (event) => {
        selectedWeaponIndex = parseInt(event.target.value, 10) || 0;
        const W = weapons[selectedWeaponIndex];
        const rangeKey = (W.weaponRange || "Melee").toLowerCase();

        // Auto-select the weapon's damage type in the dropdown (still overridable)
        html.find('#damageType').val(W.damageType);

        // Refresh the displayed formulas
        html.find('#selectedWeaponAccuracy').html(`
          <b>[${W.attrib1} + ${W.attrib2}] + ${Number(W.accuracyBonus) + Number(extraAccuracyInfo.all) + Number(extraAccuracyInfo[rangeKey] ?? 0)}</b>
          <span id="selectedWeaponAccuracyDetails" style="background-color: rgba(0, 0, 0, 0.60); color: #fff; text-align: center; padding: 5px 10px; margin: 0 0 0 5px; border-radius: 6px; position: absolute; z-index: 1; width: 200px">
            ${generateDetailBuffHoverBox(
              [{ name: "Weapon Accuracy", value: W.accuracyBonus }]
              .concat(buffDetails['attack_accuracy_mod_all'], buffDetails['attack_accuracy_mod_' + rangeKey])
            )}
          </span>
        `);

        html.find('#selectedWeaponDamage').html(`
          <b>${ignoreHR ? '' : 'HR + '}${Number(W.damage) + Number(extraDamageInfo.all) + Number(extraDamageInfo[rangeKey] ?? 0) + Number(extraDamageInfo[String(W.damageType).toLowerCase()] ?? 0)}</b>
          <span id="selectedWeaponDamageDetails" style="background-color: rgba(0, 0, 0, 0.60); color: #fff; text-align: center; padding: 5px 10px; margin: 0 0 0 5px; border-radius: 6px; position: absolute; z-index: 1; width: 200px">
            ${generateDetailBuffHoverBox(
              [{ name: "Weapon Damage", value: W.damage }]
              .concat(buffDetails['extra_damage_mod_all'], buffDetails['extra_damage_mod_' + rangeKey], buffDetails['extra_damage_mod_' + String(W.damageType).toLowerCase()])
            )}
          </span>
        `);

        // Re-hide tooltips after re-render
        html.find('#selectedWeaponAccuracyDetails').hide();
        html.find('#selectedWeaponDamageDetails').hide();
      });

      // (B) Damage Type changed manually → keep UI numbers coherent
      html.find('#damageType').on("change", () => {
        const W = weapons[selectedWeaponIndex];
        const rangeKey = (W.weaponRange || "Melee").toLowerCase();
        const newDT = String(html.find('#damageType').val() || W.damageType || "Physical");
        html.find('#selectedWeaponDamage').html(`
          <b>${ignoreHR ? '' : 'HR + '}${Number(W.damage) + Number(extraDamageInfo.all) + Number(extraDamageInfo[rangeKey] ?? 0) + Number(extraDamageInfo[newDT.toLowerCase()] ?? 0)}</b>
          <span id="selectedWeaponDamageDetails" style="background-color: rgba(0, 0 0, 0.60); color: #fff; text-align: center; padding: 5px 10px; margin: 0 0 0 5px; border-radius: 6px; position: absolute; z-index: 1; width: 200px">
            ${generateDetailBuffHoverBox(
              [{ name: "Weapon Damage", value: W.damage }]
              .concat(buffDetails['extra_damage_mod_all'], buffDetails['extra_damage_mod_' + rangeKey], buffDetails['extra_damage_mod_' + newDT.toLowerCase()])
            )}
          </span>
        `);
        html.find('#selectedWeaponDamageDetails').hide();
      });

      // (C) Ignore HR check toggled → update the displayed damage label
      html.find('#ignoreHR').on("change", () => {
        ignoreHR = html.find('#ignoreHR').prop("checked");
        const W = weapons[selectedWeaponIndex];
        const rangeKey = (W.weaponRange || "Melee").toLowerCase();
        const curDT = String(html.find('#damageType').val() || W.damageType || "Physical");
        html.find('#selectedWeaponDamage').html(`
          <b>${ignoreHR ? '' : 'HR + '}${Number(W.damage) + Number(extraDamageInfo.all) + Number(extraDamageInfo[rangeKey] ?? 0) + Number(extraDamageInfo[curDT.toLowerCase()] ?? 0)}</b>
          <span id="selectedWeaponDamageDetails" style="background-color: rgba(0, 0, 0, 0.60); color: #fff; text-align: center; padding: 5px 10px; margin: 0 0 0 5px; border-radius: 6px; position: absolute; z-index: 1; width: 200px">
            ${generateDetailBuffHoverBox(
              [{ name: "Weapon Damage", value: W.damage }]
              .concat(buffDetails['extra_damage_mod_all'], buffDetails['extra_damage_mod_' + rangeKey], buffDetails['extra_damage_mod_' + curDT.toLowerCase()])
            )}
          </span>
        `);
        html.find('#selectedWeaponDamageDetails').hide();
      });
    },
    buttons: {
      confirm: {
        label: "Attack",
        callback: async html => {
          // 1) Collect values from the dialog
          const wIdx       = parseInt(html.find('#weapon').val() ?? "0", 10) || 0;
          const W          = weapons[wIdx];
          const ignoreHR   = html.find('#ignoreHR').prop("checked");
          const bonusAcc   = parseInt((html.find('#bonusAcc').val() ?? "0").toString().trim() || "0", 10);
          const bonusDmg   = parseInt((html.find('#bonusDmg').val() ?? "0").toString().trim() || "0", 10);
          const pickedDT   = String(html.find('#damageType').val() || W.damageType || "Physical");

          // 2) Compute totals the same way you *display* them (no rolls here)
          const rangeKey   = (W.weaponRange || "Melee").toLowerCase(); // melee|ranged
          const typeKey    = pickedDT.toLowerCase();

          const totalCheckBonus =
            Number(W.accuracyBonus || 0) +
            Number(extraAccuracyInfo.all || 0) +
            Number(extraAccuracyInfo[rangeKey] || 0) +
            Number(bonusAcc || 0);

          const baseDamageNoHR =
            Number(W.damage || 0) +
            Number(extraDamageInfo.all || 0) +
            Number(extraDamageInfo[rangeKey] || 0) +
            Number(extraDamageInfo[typeKey] || 0) +
            Number(bonusDmg || 0);

          // 3) Forward to ActionDataFetch (no chat card here)
          const fetchMacro = game.macros.getName("ActionDataFetch");
          if (!fetchMacro) return ui.notifications.error('Macro "ActionDataFetch" not found.');

          await fetchMacro.execute({
            __AUTO: true,
            __PAYLOAD: {
              source: "Weapon",
              attacker_uuid: (actor?.uuid || actor?.id || null),
              overrides: {
                // Keep the Old UI’s naming, but ADF may replace/normalize as needed
                skill_name   : `Attack — ${W.name}`,
                weapon_name  : W.name,
                skill_img    : actor.img || "",
                skill_range  : W.weaponRange || "Melee",

                // ✅ NEW: force Free Mode in JRPG Targeting API
                skill_target : "-",

                // ✅ UPDATED: pass weapon type forward when available (ex: "Bow")
                weapon_type  : W.weaponType || "",

                rolled_atr1  : W.attrib1 || "DEX",
                rolled_atr2  : W.attrib2 || "DEX",
                // v0.2 — Pass the template UUID when present so ADF resolves the item
                weapon_uuid  : (W.weaponUuid || null),
                check_bonus  : totalCheckBonus,
                damage_bonus : Math.max(0, baseDamageNoHR),
                type_damage  : pickedDT || W.damageType || "Physical",
                reduction    : 0,
                bonus        : 0,
                multiplier   : 100,
                raw_effect   : "",
                ignore_hr    : !!ignoreHR
              },

              // Targeting is now owned by the JRPG Targeting API, not this dialog.
              targets: []
            }
          });
        }
      },
      cancel: { label: "Cancel" }
    }
  }).render(true);
}

// Kick it off
fabulaUltimaAttack();
