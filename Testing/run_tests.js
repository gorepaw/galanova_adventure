"use strict";
// =============================================================================
// GALANOVA TEST HARNESS
//
// Runs each engine system's own self-test against the CURRENT game data, then
// prints an aggregated summary and exits non-zero on any failure.
//
// The self-tests live next to the code they cover, so they stay current as the
// systems evolve — this harness just loads the engine in dependency order and
// invokes them. Run with:  node Testing/run_tests.js
// =============================================================================

// Load engine modules into the global scope (they reference each other as
// globals, mirroring how electron-main concatenates them).
function load(rel) {
  const exports = require(rel);
  if (exports && typeof exports === "object") Object.assign(global, exports);
  return exports;
}

load("../Engine/datalayer.js");      // DataStore, Loader, SyntheticData, TestSuite
const itemsuffixes = load("../Engine/itemsuffixes.js");
load("../Engine/leveltables.js");
const skills     = load("../Engine/skills.js");
load("../Engine/companions.js");
const encounters = load("../Engine/encounters.js");
const dungeons   = load("../Engine/dungeons.js");
const equipment  = load("../Engine/equipment.js");
load("../Engine/gameplayloop.js");   // SyntheticGameData, GameLoopTests, HomeScreen…

// Seed the real game data (zones, enemies, items, the starting character/save)
// so the self-tests that drive DataStore/Loader have current content to use.
// (datalayer's SyntheticData.seed() — encounter tables + fixtures — already ran
//  on load.)
SyntheticGameData.seed();

// ── generic reporter for suites without a bespoke report() ───────────────────
const genericReport = (title, r) => {
  const lines = [
    `\n${"=".repeat(60)}`,
    `${title}: ${r.passed}/${r.total} passed`,
    "=".repeat(60),
    ...r.results.filter(x => !x.ok).map(x => `  ✗ ${x.label}`),
    r.failed > 0 ? `  ${r.failed} FAILED` : "  All tests passed.",
    "=".repeat(60),
  ];
  return lines.join("\n");
};

// ── run every current-system self-test ───────────────────────────────────────
const suites = [
  { title: "DATA LAYER",     run: () => TestSuite.run(),                              report: TestSuite.report },
  { title: "CLASS / ARMOR",  run: () => equipment.runClassTests(),                    report: equipment.reportClassTests },
  { title: "ITEM SUFFIXES",  run: () => itemsuffixes.runSuffixTests(),                 report: itemsuffixes.reportSuffixTests },
  { title: "SKILLS",         run: () => skills.runSkillTests() },
  { title: "ENCOUNTERS",     run: () => encounters.runEncounterTests(DataStore, Loader, null), report: encounters.reportEncounterTests },
  { title: "DUNGEONS",       run: () => dungeons.runDungeonTests(DataStore, Loader),   report: dungeons.reportDungeonTests },
  { title: "GAME LOOP",      run: () => GameLoopTests.run(),                           report: GameLoopTests.report },
];

let totalPass = 0, totalFail = 0;
const suiteLines = [];

for (const s of suites) {
  let r;
  try {
    r = s.run();
  } catch (e) {
    totalFail += 1;
    suiteLines.push(`${s.title}: THREW — ${e.message}`);
    console.log(`\n${s.title}: THREW — ${e.message}`);
    continue;
  }
  totalPass += r.passed;
  totalFail += r.failed;
  suiteLines.push(`${r.failed ? "✗" : "✓"} ${s.title.padEnd(16)} ${r.passed}/${r.total}`);
  console.log(s.report ? s.report(r) : genericReport(s.title, r));
}

// ── aggregated summary ───────────────────────────────────────────────────────
console.log(`\n${"#".repeat(60)}`);
console.log("#  GALANOVA TEST SUMMARY");
console.log("#".repeat(60));
for (const line of suiteLines) console.log("#  " + line);
console.log("#".repeat(60));
console.log(`#  TOTAL: ${totalPass}/${totalPass + totalFail} passed` +
  (totalFail > 0 ? `  —  ${totalFail} FAILED` : "  —  ALL GREEN"));
console.log("#".repeat(60) + "\n");

process.exit(totalFail > 0 ? 1 : 0);
