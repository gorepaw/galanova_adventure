// =============================================================================
// RANDOM ITEM SUFFIX SYSTEM — Kalimdor RPG
//
// Implements Classic WoW's "random enchantment" items — the world-drop greens
// that can be looted plain, or with a randomly rolled suffix like "of the
// Bear" (+Strength +Stamina) or "of Intellect" appended to their name.
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
// STAT MAGNITUDE: modeled on Blizzard's published itemization budget economy
// (a base point budget derived from item level, scaled by a per-slot
// multiplier, split across the suffix's stat(s) with a per-stat cost
// weight — Stamina is "cheaper" so it rolls higher numbers than primary
// stats). This is NOT a byte-exact reproduction of Blizzard's internal
// RandPropPoints / ScalingStatDistribution tables — it's a faithful,
// internally-consistent approximation tuned for this game's low item levels.
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
  const maybeApplySuffix = (itemId) => {
    const ir = Loader.load(`templates/items/${itemId}`, "item");
    if (!ir.ok || !isEligibleBaseItem(ir.data)) return itemId;
    if (Math.random() >= ROLL_CHANCE) return itemId;
    const suffixKey = SUFFIX_KEYS[Math.floor(Math.random() * SUFFIX_KEYS.length)];
    return `${itemId}__${suffixKey}`;
  };

  const isEligible = (itemId) => {
    const ir = Loader.load(`templates/items/${itemId}`, "item");
    return ir.ok && isEligibleBaseItem(ir.data);
  };

  return {
    SUFFIX_GROUPS, SUFFIX_KEYS,
    greenBudget, slotMultiplier, computeStatBonuses,
    isEligibleBaseItem, isEligible,
    buildVariant, generateAllVariants, maybeApplySuffix,
  };
})();

if (typeof module !== "undefined") {
  module.exports = { ItemSuffixes };
}
