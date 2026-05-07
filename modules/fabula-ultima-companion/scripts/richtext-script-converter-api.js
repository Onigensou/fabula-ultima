/**
 * [ONI][RichTextScript] Foundry VTT v12
 * Convert rich text (HTML) into readable JS script text for downstream macros/scripts.
 *
 * API:
 *   game.modules.get(MODULE_ID).api.richText.toScript(html)
 *   game.modules.get(MODULE_ID).api.richText.compile(html, argNames?)
 *   game.modules.get(MODULE_ID).api.richText.run(html, { args: [], argNames: [] })
 */

(() => {
  const MODULE_ID = "fabula-ultima-companion"; // <-- change if your module id differs
  const TAG = "[ONI][RichTextScript]";

  /** Core: HTML -> plain text (same idea as your ActionAnimationHandler) */
  function htmlToPlain(html = "") {
    // DOM-based decode & strip tags (works in Foundry client)
    const container = document.createElement("div");
    container.innerHTML = String(html ?? "");

    // Prefer paragraph-aware formatting (keeps spacing like the editor shows it)
    const paragraphs = container.querySelectorAll("p");
    if (paragraphs.length > 0) {
      const lines = Array.from(paragraphs).map(p => (p.textContent || "").trimEnd());
      return lines.join("\n\n");
    }

    // Fallback: just take text
    const text = container.textContent || container.innerText || "";
    return text;
  }

  /** Extra cleanup tuned for “code stored in rich text editors” */
  function normalizeScriptText(text = "") {
    let s = String(text ?? "");

    // Convert CRLF -> LF
    s = s.replace(/\r\n/g, "\n");

    // Convert non-breaking spaces to normal spaces
    s = s.replace(/\u00A0/g, " ");

    // Trim end-of-lines (keeps indentation but removes trailing whitespace)
    s = s.split("\n").map(line => line.replace(/\s+$/g, "")).join("\n");

    // Trim leading/trailing empty lines
    s = s.trim();

    return s;
  }

  /**
   * Public: Convert rich text HTML into clean JS source text.
   * @param {string} html
   * @param {object} [opts]
   * @param {boolean} [opts.keepParagraphSpacing=true]  If false, we won't join <p> with blank lines.
   */
  function toScript(html, opts = {}) {
    const { keepParagraphSpacing = true } = opts;

    if (!html) return "";

    // If you don’t want paragraph spacing, we can bypass the <p> special case:
    let plain;
    if (keepParagraphSpacing) {
      plain = htmlToPlain(html);
    } else {
      const container = document.createElement("div");
      container.innerHTML = String(html ?? "");
      plain = container.textContent || container.innerText || "";
    }

    return normalizeScriptText(plain);
  }

  /**
   * Compile a function from rich text HTML.
   * Default signature: (payload, targets)
   * @param {string} html
   * @param {string[]} [argNames=["payload","targets"]]
   * @returns {Function}
   */
  function compile(html, argNames = ["payload", "targets"]) {
    const js = toScript(html);
    if (!js) {
      throw new Error(`${TAG} compile() received empty script.`);
    }
    // Build function with strict mode
    return new Function(...argNames, `"use strict";\n${js}`);
  }

  /**
   * Run rich text script immediately.
   * @param {string} html
   * @param {object} [options]
   * @param {any[]} [options.args=[]] Values passed into the compiled function
   * @param {string[]} [options.argNames=["payload","targets"]] Names for function parameters
   * @param {object|null} [options.publishGlobals] If provided, temporarily publishes globals:
   *    { PAYLOAD: payloadObj, TARGETS: targetsArr } -> globalThis.__PAYLOAD/__TARGETS
   */
  async function run(html, options = {}) {
    const {
      args = [],
      argNames = ["payload", "targets"],
      publishGlobals = null
    } = options;

    const fn = compile(html, argNames);

    // Optional: mimic your ActionAnimationHandler global publishing pattern
    const prevPAYLOAD = globalThis.__PAYLOAD;
    const prevTARGETS = globalThis.__TARGETS;

    try {
      if (publishGlobals) {
        globalThis.__PAYLOAD = publishGlobals.PAYLOAD ?? prevPAYLOAD;
        globalThis.__TARGETS = publishGlobals.TARGETS ?? prevTARGETS;
      }

      const result = fn(...args);
      if (result && typeof result.then === "function") {
        return await result;
      }
      return result;
    } finally {
      if (publishGlobals) {
        globalThis.__PAYLOAD = prevPAYLOAD;
        globalThis.__TARGETS = prevTARGETS;
      }
    }
  }

  function getApi() {
    return {
      // simple conversion
      toScript,
      // advanced helpers
      compile,
      run,
      // exposed building blocks (if you want them elsewhere)
      _htmlToPlain: htmlToPlain,
      _normalizeScriptText: normalizeScriptText
    };
  }

  // Bootstrap-style registration (no imports)
  Hooks.once("init", () => {
    const mod = game.modules.get(MODULE_ID);
    if (!mod) {
      console.error(`${TAG} Module not found: ${MODULE_ID}`);
      return;
    }

    // Keep existing api keys if you already have some
    mod.api = mod.api || {};
    mod.api.richText = getApi();

    // Optional: also expose a global alias if you like
    globalThis.OniRichTextScript = mod.api.richText;
  });
})();
