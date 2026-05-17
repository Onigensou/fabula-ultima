const { ClassicLevel } = require("classic-level");

async function main() {
  const db = new ClassicLevel(
    "C:\\Users\\Oni\\AppData\\Local\\FoundryVTT\\Data\\worlds\\fabula-ultima-2\\data\\macros",
    { valueEncoding: "json" }
  );
  try {
    for await (const [key, val] of db.iterator()) {
      const name = val?.name ?? "";
      if (
        name.includes("SummaryUI") ||
        name.includes("Active-Effect") ||
        name.includes("Active Effect") ||
        name.includes("ActiveEffect") ||
        name.includes("Listener") && name.includes("Battle")
      ) {
        console.log(JSON.stringify({ _id: val._id, name }));
      }
    }
  } finally { await db.close(); }
}
main().catch(console.error);
