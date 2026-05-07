// scripts/warehouse-system/warehouse-gates.js
// ----------------------------------------------------------------------------
// ONI Warehouse — Gate Logic (Validation only)
// - Never mutates inventory in the world
// - Validates payload.plan against payload.snapshot
// - Writes result into payload.gates (ok/errors/warnings)
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";

export class WarehouseGates {
  static validate(payload) {
    payload.gates = payload.gates ?? {};
    payload.gates.ok = true;
    payload.gates.errors = [];
    payload.gates.warnings = [];

    const addError = (msg, data = {}) => {
      payload.gates.ok = false;
      payload.gates.errors.push({ msg, data, ts: Date.now() });
    };

    // -----------------------------
    // 1) Validate Zenit plan
    // -----------------------------
    const actorZenit = Number(payload.snapshot?.actorZenit ?? 0);
    const storageZenit = Number(payload.snapshot?.storageZenit ?? 0);

    const dep = Math.max(0, Math.floor(Number(payload.plan?.zenit?.depositToStorage ?? 0)));
    const wit = Math.max(0, Math.floor(Number(payload.plan?.zenit?.withdrawFromStorage ?? 0)));

    // Normalize plan values (keep them non-negative ints in payload)
    payload.plan.zenit = payload.plan.zenit ?? {};
    payload.plan.zenit.depositToStorage = dep;
    payload.plan.zenit.withdrawFromStorage = wit;

    if (dep > actorZenit) addError("Not enough Zenit to deposit.", { deposit: dep, actorZenit });
    if (wit > storageZenit) addError("Not enough Zenit in Storage to withdraw.", { withdraw: wit, storageZenit });

    // Optional: prevent doing both at once (if you want)
    // If you want to allow it, comment this out.
    if (dep > 0 && wit > 0) addError("Choose either Deposit or Withdraw (not both).", { dep, wit });

    // -----------------------------
    // 2) Validate Item move plan
    // -----------------------------
    const moves = payload.plan?.itemMoves ?? [];

    // Build base qty map from snapshot for actor/storage
    const baseActor = new Map();
    const baseStorage = new Map();

    for (const it of payload.snapshot?.actorItems ?? []) {
      const uuid = it.itemUuid ?? it.uuid;
      if (!uuid) continue;
      baseActor.set(uuid, Number(it.qty ?? 1));
    }
    for (const it of payload.snapshot?.storageItems ?? []) {
      const uuid = it.itemUuid ?? it.uuid;
      if (!uuid) continue;
      baseStorage.set(uuid, Number(it.qty ?? 1));
    }

    // Apply deltas and ensure no side goes negative
    const deltaActor = new Map();
    const deltaStorage = new Map();

    const inc = (map, k, v) => map.set(k, (map.get(k) ?? 0) + v);

    for (const m of moves) {
      const qty = Math.max(0, Math.floor(Number(m.qty ?? 0)));
      if (!m.itemUuid || qty <= 0) continue;

      if (m.from === "actor") inc(deltaActor, m.itemUuid, -qty);
      if (m.to === "actor") inc(deltaActor, m.itemUuid, +qty);

      if (m.from === "storage") inc(deltaStorage, m.itemUuid, -qty);
      if (m.to === "storage") inc(deltaStorage, m.itemUuid, +qty);
    }

    const checkSide = (sideName, baseMap, deltaMap) => {
      for (const [uuid, d] of deltaMap.entries()) {
        const base = baseMap.get(uuid) ?? 0;
        const finalQty = base + d;
        if (finalQty < 0) {
          addError(`Planned item transfer exceeds available quantity (${sideName}).`, {
            side: sideName,
            itemUuid: uuid,
            base,
            delta: d,
            finalQty
          });
        }
      }
    };

    checkSide("actor", baseActor, deltaActor);
    checkSide("storage", baseStorage, deltaStorage);

    WarehouseDebug.log(payload, "GATE", "Validate gates", {
      ok: payload.gates.ok,
      errors: payload.gates.errors.length,
      moves: moves.length,
      zenit: { dep, wit }
    });

    return payload.gates.ok;
  }
}
