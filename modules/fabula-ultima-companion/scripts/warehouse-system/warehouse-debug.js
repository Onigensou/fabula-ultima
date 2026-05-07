// scripts/warehouse/Debug.js
// ----------------------------------------------------------------------------
// ONI Warehouse — Debug Helper (Foundry V12)
// - Consistent console logging tags
// - Optional payload.audit append-only log
// ----------------------------------------------------------------------------

export class WarehouseDebug {
  static TAG = "[Warehouse]";

  /**
   * Decide whether to print debug logs.
   * Priority:
   *  1) payload.meta.debug if present
   *  2) globalThis.ONI_WAREHOUSE_DEBUG if present
   *  3) default true (during build phase)
   */
  static isDebugEnabled(payload) {
    if (payload?.meta?.debug !== undefined) return !!payload.meta.debug;
    if (globalThis.ONI_WAREHOUSE_DEBUG !== undefined) return !!globalThis.ONI_WAREHOUSE_DEBUG;
    return true;
  }

  /**
   * Append-only audit log stored in payload (never removes).
   */
  static audit(payload, stage, data = {}) {
    try {
      payload.audit = payload.audit ?? [];
      payload.audit.push({
        t: Date.now(),
        stage,
        data
      });
    } catch (_) {
      // Never let audit crash the system.
    }
  }

  static log(payload, stage, message = "", data = {}) {
    if (!this.isDebugEnabled(payload)) return;
    console.log(`${this.TAG}${stage ? "[" + stage + "]" : ""} ${message}`, data);
    this.audit(payload, stage || "LOG", { message, ...data });
  }

  static warn(payload, stage, message = "", data = {}) {
    console.warn(`${this.TAG}${stage ? "[" + stage + "]" : ""} ${message}`, data);
    this.audit(payload, stage || "WARN", { message, ...data });
  }

  static error(payload, stage, message = "", data = {}) {
    console.error(`${this.TAG}${stage ? "[" + stage + "]" : ""} ${message}`, data);
    this.audit(payload, stage || "ERROR", { message, ...data });
  }
}
