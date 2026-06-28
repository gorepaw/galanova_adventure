// =============================================================================
// RANDOM ITEM SUFFIX SYSTEM — Galanova
//
// World-drop items that can be looted plain, or with a randomly rolled stat
// suffix like "of the Brute" (+str +con) or "of Intellect" appended to their
// name. Uses the 8 Galanova stats (str/dex/con/int/spi/wis/spd/cha).
//
// HOW IT WORKS:
//   Base items in Data/items.json that are eligible carry the tag
//   "randomEnchant" in their `tags` array. For every such base item, this
//   module precomputes one synthetic item definition per suffix group in
//   Data/item_suffixes.json (e.g. "primal_belt" -> "primal_belt__bear",
//   "primal_belt__monkey", ...). Those synthetic definitions are plain,
//   schema-valid item objects — they get merged into the same item registry
//   (DataStore "templates/items/*" and Electron's _itemTemplates) as the
//   static items, so nothing downstream (equip, shop, bag UI) needs to know
//   the suffix system exists.
//
//   At loot-roll time (RewardEngine.rollLoot in gameplayloop.js), a random
//   chance decides whether an eligible drop's itemId gets swapped for one of
//   its suffixed variant ids instead of the plain base id.
//
// STAT MAGNITUDE: a budget economy — a base point budget derived from item
// level, scaled by a per-slot multiplier, split across the suffix's stat(s)
// with a per-stat cost weight (a cheaper stat rolls higher numbers). Cost
// weights live in Data/item_suffixes.json (currently all 1.0 — equal magnitude).
// Tuned for this game's low item levels.
//
// DEPENDENCIES: Data/item_suffixes.json. Uses DataStore/Loader as globals
// (set up by datalayer.js) the same way gameplayloop.js does — load this
// file AFTER datalayer.js and BEFORE gameplayloop.js.
// =============================================================================

"use strict";

const _suffixData = require('../Data/item_suffixes.json');

const ItemSuffixes = (() => {

  const SUFFIX_GROUPS   = _suffixData.suffixGroups;
  const STAT_COST       = _suffixData.statCost;
  const SLOT_MULT       = _suffixData.slotMultipliers;
  const ROLL_CHANCE     = _suffixData.rollChance;
  // Separate chance for crafted output (vs world-drop loot). Defaults to 0 so
  // crafting never suffixes unless explicitly enabled in the data.
  const CRAFT_ROLL_CHANCE = _suffixData.craftRollChance ?? 0;
  const VALUE_MULT      = _suffixData.valueMultiplier;
  const UPGRADED_QUALITY = _suffixData.upgradedQuality;

  const SUFFIX_KEYS = Object.keys(SUFFIX_GROUPS);
  const TWO_HANDED  = new Set(["sword_2h", "axe_2h", "mace_2h", "staff", "polearm"]);
  const RANGED      = new Set(["bow", "crossbow", "gun", "wand", "thrown"]);

  // Base point budget for an "uncommon" (green) quality item at the given level.
  // Modeled on the public itemization formula: budget ≈ 0.5*ilvl - 2, floored
  // at a small minimum so low-level items still get a noticeable bonus.
  const greenBudget = (itemLevel) => Math.max(2, Math.round(0.5 * (itemLevel || 1) - 2));

  // How much of the budget a given item slot/weapon type gets to spend.
  const slotMultiplier = (item) => {
    if (item.type === "weapon") {
      const wt = item.weaponType;
      if (RANGED.has(wt))     return SLOT_MULT.weapon_ranged;
      if (TWO_HANDED.has(wt)) return SLOT_MULT.weapon_2h;
      return SLOT_MULT.weapon_1h;
    }
    return SLOT_MULT[item.slot] ?? 0.55;
  };

  // Computes the {stat: points} bonus a suffix grants on a given base item.
  const computeStatBonuses = (baseItem, suffixKey) => {
    const suffix = SUFFIX_GROUPS[suffixKey];
    const budget = greenBudget(baseItem.itemLevel) * slotMultiplier(baseItem);
    const share  = budget / suffix.stats.length;
    const bonuses = {};
    for (const stat of suffix.stats) {
      const cost = STAT_COST[stat] || 1;
      bonuses[stat] = Math.max(1, Math.round(share / cost));
    }
    return bonuses;
  };

  const upgradeQuality = (quality) => {
    const order = ["poor", "common", "uncommon", "rare", "epic", "legendary"];
    const upgradedIdx = order.indexOf(UPGRADED_QUALITY);
    const idx = order.indexOf(quality);
    return idx >= upgradedIdx ? quality : UPGRADED_QUALITY;
  };

  const isEligibleBaseItem = (item) => !!item && Array.isArray(item.tags) && item.tags.includes("randomEnchant");

  // Builds the synthetic suffixed-item definition for one (baseItem, suffixKey) pair.
  const buildVariant = (baseItem, suffixKey) => {
    const suffix = SUFFIX_GROUPS[suffixKey];
    const bonus  = computeStatBonuses(baseItem, suffixKey);
    return {
      ...baseItem,
      id:    `${baseItem.id}__${suffixKey}`,
      name:  `${baseItem.name} ${suffix.suffix}`,
      statBonuses: { ...(baseItem.statBonuses || {}), ...bonus },
      value:   Math.max(1, Math.round((baseItem.value || 0) * VALUE_MULT)),
      quality: upgradeQuality(baseItem.quality),
      tags:    [...(baseItem.tags || []), "suffixed", `suffix_${suffixKey}`],
    };
  };

  // Generates every (baseItem × suffixGroup) variant for a whole items map
  // (e.g. _itemsData.items). Returns a flat array of item definitions ready
  // to be written into the item registry alongside the static items.
  const generateAllVariants = (itemsMap) => {
    const out = [];
    for (const baseItem of Object.values(itemsMap || {})) {
      if (!isEligibleBaseItem(baseItem)) continue;
      for (const suffixKey of SUFFIX_KEYS) out.push(buildVariant(baseItem, suffixKey));
    }
    return out;
  };

  // Decides whether a looted itemId should be upgraded to a random-suffix
  // variant. Looks up the base item via Loader (DataStore must already be
  // seeded). Returns the original itemId unchanged if not eligible, or if
  // the roll misses (rollChance is 1.0 by default — in Classic, these
  // world-drop templates essentially always rolled some suffix; the bare
  // unsuffixed item rarely if ever actually dropped).
  const maybeApplySuffix = (itemId, chance = ROLL_CHANCE) => {
    const ir = Loader.load(`templates/items/${itemId}`, "item");
    if (!ir.ok || !isEligibleBaseItem(ir.data)) return itemId;
    if (Math.random() >= chance) return itemId;
    const suffixKey = SUFFIX_KEYS[Math.floor(Math.random() * SUFFIX_KEYS.length)];
    return `${itemId}__${suffixKey}`;
  };

  const isEligible = (itemId) => {
    const ir = Loader.load(`templates/items/${itemId}`, "item");
    return ir.ok && isEligibleBaseItem(ir.data);
  };

  return {
    SUFFIX_GROUPS, SUFFIX_KEYS, ROLL_CHANCE, CRAFT_ROLL_CHANCE,
    greenBudget, slotMultiplier, computeStatBonuses,
    isEligibleBaseItem, isEligible,
    buildVariant, generateAllVariants, maybeApplySuffix,
  };
})();

// =============================================================================
// SELF-TEST
// =============================================================================

const runSuffixTests = () => {
  const results = []; let p = 0, f = 0;
  const assert = (label, cond) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  const base = {
    id: "suffix_test_helm", name: "Test Helm", _version: 1, type: "armor",
    slot: "head", itemLevel: 20, statBonuses: {}, value: 50, quality: "common",
    tags: ["armor", "randomEnchant"],
  };
  const variants = ItemSuffixes.generateAllVariants({ suffix_test_helm: base });

  assert("one variant per suffix group", variants.length === ItemSuffixes.SUFFIX_KEYS.length);

  const brute = variants.find(v => v.id === "suffix_test_helm__brute");
  assert("paired suffix exists (of the Brute)", !!brute);
  assert("paired suffix grants both stats",     brute && brute.statBonuses.str > 0 && brute.statBonuses.con > 0);
  assert("paired suffix names the item",        brute && brute.name === "Test Helm of the Brute");

  const con = variants.find(v => v.id === "suffix_test_helm__constitution");
  assert("single suffix grants its stat (con)", con && con.statBonuses.con > 0);

  const ALLOWED = new Set(["str", "dex", "con", "int", "spi", "wis", "spd", "cha"]);
  const used = new Set();
  variants.forEach(v => Object.keys(v.statBonuses).forEach(s => used.add(s)));
  assert("only Galanova stats used",            [...used].every(s => ALLOWED.has(s)));
  assert("no legacy agi/sta stats",            !used.has("agi") && !used.has("sta"));

  assert("suffixed items upgrade quality",      variants.every(v => v.quality === "uncommon"));
  assert("value multiplied",                    con && con.value === Math.round(50 * 1.5));
  assert("non-randomEnchant items ignored",     ItemSuffixes.generateAllVariants({ x: { id: "x", tags: [] } }).length === 0);

  // maybeApplySuffix honours a chance override (the crafting path passes craftRollChance)
  if (typeof DataStore !== "undefined" && typeof Loader !== "undefined") {
    DataStore.write("templates/items/suffix_test_helm", base);
    assert("chance 1.0 → always suffixed", ItemSuffixes.maybeApplySuffix("suffix_test_helm", 1).startsWith("suffix_test_helm__"));
    assert("chance 0 → never suffixed",    ItemSuffixes.maybeApplySuffix("suffix_test_helm", 0) === "suffix_test_helm");
    DataStore.remove("templates/items/suffix_test_helm");
  }

  return { passed: p, failed: f, total: p + f, results };
};

const reportSuffixTests = (r) => {
  const lines = [
    `\n${"=".repeat(60)}`,
    `ITEM SUFFIX TESTS: ${r.passed}/${r.total} passed`,
    "=".repeat(60),
    ...r.results.filter(x => !x.ok).map(x => `  ✗ ${x.label}`),
    r.failed > 0 ? `  ${r.failed} FAILED` : "  All tests passed.",
    "=".repeat(60),
  ];
  return lines.join("\n");
};

if (typeof module !== "undefined") {
  module.exports = { ItemSuffixes, runSuffixTests, reportSuffixTests };
}
