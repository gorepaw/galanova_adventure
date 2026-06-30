"use strict";
// =============================================================================
// GALANOVA TEST HARNESS
//
// Runs each engine system's own self-test against the CURRENT game data, then
// prints an aggregated summary and exits non-zero on any failure.
//
// The self-tests live next to the code they cover, so they stay current as the
// systems evolve — this harness just loads the engine and invokes them. Run
// with:  node Testing/run_tests.js  (after `npm run build:engine`, which `npm
// test` does for you).
//
// The engine is now TypeScript: every module imports its siblings directly, so
// this harness no longer concatenates exports onto `global` — it just requires
// each compiled module and reads the suites off the returned exports.
// =============================================================================

const datalayer    = require("../Engine/datalayer.js");
const itemsuffixes = require("../Engine/itemsuffixes.js");
require("../Engine/leveltables.js");
const skills       = require("../Engine/skills.js");
require("../Engine/companions.js");
const encounters   = require("../Engine/encounters.js");
const dungeons     = require("../Engine/dungeons.js");
const equipment    = require("../Engine/equipment.js");
const gameplay     = require("../Engine/gameplayloop.js");

const { DataStore, Loader, TestSuite } = datalayer;
const { SyntheticGameData, GameLoopTests } = gameplay;

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
