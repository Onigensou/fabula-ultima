"use strict";

// Add the "Guest" roster section to the Global_Database CSB template.
//
// A Guest is a party-side helper that fights alongside the party but can never
// be targeted, counted or defeated (flags["fabula-ultima-companion"].bdGuest).
// Until now the only way to have one was to hand-build a Battle Director
// payload — there was no authoring surface at all. This adds one: a dynamic
// table on the party sheet, beside the existing Bench / Away roster panels.
//
// Shape mirrors the sibling roster sections: an Actor ID text field (the same
// contract bench_id_* / away_id_* use, so a GM who knows one knows the other),
// plus a name column the sync fills in and an "In Party" checkbox that decides
// whether the guest actually deploys.
//
// Placement: FIRST child of the roster panel, above "Bench Member" — a guest
// fights, the bench and the away list do not, so it belongs nearer the active
// party than to them.
//
// Usage:
//   node tools/csb-template/scripts/_add-guest-section.js --dry-run
//   node tools/csb-template/scripts/_add-guest-section.js --targets sandbox
//   node tools/csb-template/scripts/_add-guest-section.js --targets all
//
// GAME MUST BE CLOSED (direct LevelDB write).

const { CsbTree, build } = require("../lib/tree");
const { lint } = require("../lib/lint");
const { loadFromDb, saveToDb } = require("../lib/source");

const TABLE_KEY = "guest_table";
const PANEL_CLASS = "fud-guest-roster";

// Every document that carries a copy of this component tree. CSB copies the
// template body INTO each instance, so the master alone is not enough.
const TARGETS = {
  sandbox: [
    { uuid: "Actor.s83oeBb3w3LJ5l1X", label: "Global_Database (Copy)  [sandbox, 0 instances]" },
  ],
  live: [
    { uuid: "Actor.WpwYah7A9Vync3r6", label: "Global_Database          [MASTER template]" },
    { uuid: "Actor.t6E3CQ0pGxwLgXrn", label: "EXFURSION Party          [current game]" },
  ],
  // Older party actors on the same template. They are not the current game's
  // DB actor, but leaving them behind means their sheets disagree with the
  // master, which is the exact drift reloadTemplate exists to fix.
  legacy: [
    { uuid: "Actor.0Ttg3RYQZUySixH1", label: "Zenit Crisis Party" },
    { uuid: "Actor.kWBUflt7qchCseqa", label: "Bobb's squad" },
    { uuid: "Actor.r1Sq3Bmku9CklaRq", label: "FJORD" },
  ],
};

// A display-only label node. `build` has no label builder — copy the exact
// shape CSB itself serializes (taken from the neighbouring bench rows).
function labelNode(value, opts = {}) {
  return {
    key: "",
    colSpan: 1,
    rowSpan: 1,
    cssClass: opts.cssClass ?? "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: "",
    visibilityFormula: "",
    type: "label",
    size: opts.size ?? "full-size",
    icon: "",
    value,
    prefix: "",
    suffix: "",
    rollMessage: "",
    altRollMessage: "",
    rollMessageToChat: true,
    altRollMessageToChat: true,
    style: opts.style ?? "label",
  };
}

function buildGuestPanel() {
  const table = build.dynamicTable(TABLE_KEY, {
    head: true,
    deleteWarning: true,
    predefinedLines: [],
    canPlayerAdd: false,      // GM-only roster, like every other party section
    hiddenColumns: [],
    sortOption: "manual",
    sortPredicates: [],
    rowLayout: [
      build.column("guest_name", "textField", {
        colName: "Name",
        tooltip: "Filled in automatically from the actor — you can override it for a display alias.",
      }),
      build.column("guest_id", "textField", {
        colName: "Actor ID",
        tooltip: "Put Actor ID here (or drag an actor onto this panel).",
        // Hidden from players: the raw id is plumbing, and a player who edits it
        // silently repoints the guest.
        //
        // 3 (ASSISTANT), not 4 (GAMEMASTER) as the sibling bench_id_* uses.
        // CSB gates rendering on `game.user.role >= role`, but Foundry's
        // `User#isGM` is true from ASSISTANT up — and `addGuest` gates on isGM.
        // At role 4 an Assistant GM could add a guest by drag-drop yet never see
        // the id column, so the sheet would hide the field from someone the code
        // lets edit it. Measured 2026-08-15 against the "GM II" (role 3) client.
        role: 3,
      }),
      build.column("guest_active", "checkbox", {
        // "Deployed", NOT "In Party". A guest is precisely NOT a party member —
        // never targeted, never counted, never defeated — and this table sits
        // directly above two sections named "... Member". "In Party" taught the
        // exact opposite of the feature's core rule, in the one word a GM would
        // use to think about it forever. (The stored key stays guest_active.)
        colName: "Deployed",
        defaultChecked: true,
        tooltip: "Unchecked = kept on the roster but does not join battles.",
      }),
    ],
  });

  return build.panel("", {
    cssClass: PANEL_CLASS,
    collapsible: true,
    // Collapsed, like its Bench / Away siblings. Guests are episodic, and an
    // always-open section pushes the parts of this sheet a GM uses weekly below
    // the fold. Safe to collapse because the module injects a live tally
    // ("Guest — 1 deployed") into the header.
    defaultCollapsed: true,
    flow: "vertical",
    align: "left",
    extra: { title: "Guest", titleStyle: "title" },
    contents: [
      // ONLY the durable half. The "drag an actor / paste its ID" half was
      // day-one instruction that turns into permanent noise, and it duplicated
      // the toolbar hint sitting 20px above it; the module now shows that text
      // in the EMPTY STATE, where it is needed and where it disappears once the
      // roster has rows. What stays is the rule a GM needs re-stating forever.
      labelNode(
        "Guests fight alongside the party, but can never be targeted, counted or defeated."
      ),
      table,
    ],
  });
}

// Locate the roster panel that holds "Bench Member" / "Away Member". Found by
// its CONTENT (the sibling titles), never by index — an index would silently
// insert into the wrong panel if the tab is ever reordered.
function findRosterPanel(tree) {
  let hit = null;
  tree.walk(({ node }) => {
    if (hit || node.type !== "panel" || !Array.isArray(node.contents)) return;
    const titles = node.contents.map((c) => (c && c.title) || "");
    if (titles.includes("Bench Member") && titles.includes("Away Member")) hit = node;
  });
  return hit;
}

async function applyTo({ uuid, label }, { dryRun }) {
  const { doc } = await loadFromDb(uuid);
  const tree = new CsbTree(doc);

  // Idempotent: an already-present section is RECONCILED to the current spec
  // rather than skipped, so a later tweak reaches every copy on a re-run
  // instead of only the docs that happened not to have it yet.
  //
  // The WHOLE panel is replaced, not just the table's columns — the label text,
  // the collapse default and the panel config all change over time too, and a
  // columns-only reconcile silently left those stale. Safe to swap wholesale:
  // a component definition holds no row DATA (rows live in system.props), so
  // nothing authored is at risk.
  const roster = findRosterPanel(tree);
  if (!roster) throw new Error(`${label}: roster panel (Bench+Away) not found`);

  const at = roster.contents.findIndex(
    (c) => c && (c.cssClass === PANEL_CLASS
      || (Array.isArray(c.contents) && c.contents.some((k) => k && k.key === TABLE_KEY))));

  if (at >= 0) {
    const before = JSON.stringify(roster.contents[at]);
    roster.contents[at] = buildGuestPanel();
    if (JSON.stringify(roster.contents[at]) === before) {
      console.log(`  SAME  ${label} — already matches spec`);
      return { skipped: true };
    }
    console.log(`  RECONCILE ${label} — panel updated to spec`);
  } else {
    roster.contents.splice(0, 0, buildGuestPanel());
  }

  // Offline lint gate — CSB validates late and thinly, so a malformed tree
  // would persist silently and only misbehave later.
  const problems = lint(tree);
  const errors = (problems.errors ?? problems.filter?.((p) => p.level === "error") ?? []);
  if (errors.length) {
    console.error(`  LINT FAIL ${label}:`);
    for (const e of errors) console.error("   ", JSON.stringify(e));
    throw new Error("lint errors — refusing to write");
  }

  // Sanity: exactly one new prop-owning key, and it is ours.
  const patch = tree.patch({ bumpVersion: true });
  const res = await saveToDb(uuid, patch, {
    note: `csb-template: add Guest roster section (${TABLE_KEY})`,
    dryRun,
  });
  console.log(`  ${dryRun ? "DRY" : "OK "}  ${label}  version -> ${patch["system.templateSystemUniqueVersion"]}`);
  return { ok: true, res };
}

(async () => {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const which = (argv[argv.indexOf("--targets") + 1] || "sandbox");
  const set = which === "all"
    ? [...TARGETS.sandbox, ...TARGETS.live, ...TARGETS.legacy]
    : which === "live" ? [...TARGETS.live]
    : which === "legacy" ? [...TARGETS.legacy]
    : [...TARGETS.sandbox];

  console.log(`add-guest-section: targets=${which} dryRun=${dryRun}`);
  for (const t of set) await applyTo(t, { dryRun });
  console.log("done.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
