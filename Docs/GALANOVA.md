# Galanova Adventure — Universe Bible

> **Status:** living document. This is the canonical source of truth for all Galanova
> lore, naming, and design decisions. Both the author (gorepaw) and Claude edit it.
> Permanent memory points here; it does not duplicate this content.
>
> **Project:** a full conversion of a JRPG/incremental game (originally built on World
> of Warcraft data as test data) into the original Galanova universe. This folder is a
> standalone copy wired to the `galanova_adventure` repo; the original WoW build lives
> in a separate copy.

---

## Setting

Galanova is a **light-grimdark space fantasy** setting. The era of the game is one in
which **six living gods** are attempting to **align the galaxy**.

**Tone:** dramatic and dark, but optimistic.

**Player fantasy:** the player explores a *radically expanding galaxy* through an
*ever-growing roster of playable species*.

---

## The Six Living Gods

The six living gods each govern a domain and bear a rune. They are attempting to align
the galaxy.

| God | Form | Domain | Rune |
|-----|------|--------|------|
| **Ceta'Canaashen** | a planet-cetacean | grants order and alignment | a line |
| **The Liquimetal God** | a metallic, amorphous planet-core | intragalactic connection, technology, and communication | a diagonal cross |
| **Trael the Greatmother** | a great golden wolf; sits at the opposite pole of Ceta'Canaashen's head | an irrational, mystical counterbalance (to Ceta'Canaashen's order) | a triangle |
| **Bukaga** | a planet-sized fungoid mass | envelops, studies, and reprocesses | a square |
| **Caelith** | banshee queen of an all-but-dead civilization of dragon-riding magi | spirit and ancestry | a pentagram |
| **Alaaga, The Stone Dragon** | a stone dragon | Empress of Matter and Force | a hexagram |

### Notes (canon)
- Spelling locked as **Ceta'Canaashen** (apostrophe form).
- **The runes are mortal-made.** They were invented by the peoples of the galaxy to
  become the symbols of the new galactic religion forming around the six gods — not
  pre-existing divine sigils. They run line → diagonal cross → triangle → square →
  pentagram → hexagram.
- **Trael** and **Ceta'Canaashen** form an order-vs-irrationality polarity (Trael sits
  at the opposite pole of Ceta'Canaashen's head).
- Ceta'Canaashen physically hosts two of the other gods on its back — **Trael** and
  **Alaaga** — along with entire species (chiefly the Ganorok and Surok).

---

## The Galaxy (places & peoples)

**Meyn-Sephir** — the galactic capital; seat of the galactic senate.

**The Sephir** — blue-skinned, six-eyed humanoids who first engineered machines to
commune with the Liquimetal God, then FTL travel. They dominate the senate.

The era is one of uneasy **unification**: galactic order is fracturing as new regions
are brought into the fold. Not all go quietly, and the unknown reaches of space pose
their own threats.

### The Starplains (region)
A relative island amid immense anomalous barriers, home to several newly FTL-capable
species:
- **Sylvari** — of the Sylvari system.
- **Korribak** — of Korribak Prime and Korribak II, and a surrounding former empire.
- **Ceta'Canaashen** — the planet-whale-god (one of the Six) resides here; on its back
  ride two other living gods (**Trael**, **Alaaga**) and several gifted species —
  chiefly the **Ganorok** and the **Surok**.

### Peoples seen so far (future playable-species candidates)
Sephir · Sylvari · Korribak · Ganorok · Surok
> _Formalized into the playable roster in a later phase — do not expand without the author._

### Game zone model
Engine zones map to Galanova geography: a **planet = region** (`regionId`), a **subzone = zone**.
- **Rath** — planet/region of the starting area.
  - **Colonial Sewers** — starter subzone (combat) beneath Rath's colonial sprawl; vermin-infested.

---

## Working Agreement (project constraints)

These are standing instructions from the author. They govern all conversion work.

1. **Maintain and respect the existing project architecture.** The data-layer machinery
   (schemas, validator, loader/saver, patcher, merger in `Engine/datalayer.js`) and
   conventions are preserved; content and specific systems change.
2. **Do not invent names without asking.** Lore, class, race, species, item, and ability
   names come from the author.
3. **Let no WoW proper noun survive.** Every World of Warcraft proper noun must be
   removed during conversion.
4. **Do not invent systems.** Mechanics/systems are designed with the author, not
   improvised.
5. **Ask before each change** unless the author says otherwise.

---

## Systems

### Primary stats (decided)
Eight primary stats. Per-race/class **values** are deferred to the roster phase, and the
per-level gain tables are being retired in favor of **stat-point allocation**.

| Stat | Drives |
|------|--------|
| `str` (strength) | attack power (str×2) |
| `dex` (dexterity) | attack power (+dex), melee crit, armor (dex×2) |
| `con` (constitution) | max HP (con×10) |
| `int` (intellect) | max mana (int×15), spell crit |
| `spi` (spirit) | mana regen |
| `wis` (wisdom) | non-physical resistance (+0.5 / point, all schools) |
| `spd` (speed) | combat initiative (turn order) + dodge (0.05% / point) |
| `cha` (charisma) | social / economy (dialogue, prices, recruitment) — **no combat math** |

### Damage / resistance schools (decided)
`physical`, `pyro`, `cryo`, `nature`, `chaos`, `order`, `bio`, `energy`, `psychic`
— replaces the old fire/frost/nature/shadow/holy/arcane set. `wis` grants resistance to
all non-physical schools.

### Dodge (decided & wired)
Dodge applies to **physical** attacks only (magic ignores it). A target's effective dodge
= `spd`-derived dodge (0.05%/pt) + any buff `dodgeChance` modifiers, **capped at 75%**.
On a successful dodge the attack deals 0 damage and triggers no on-hit effects. Wired in
the combat path (gameplayloop `CombatBridge` — `run` for auto, `stepTurn` for manual).

### Progression & levels (decided)
- **Hard level cap: 99.** Levels run 1–99; 99 is the absolute ceiling (no over-leveling
  beyond it). (Old maxLevel 60 / xpTable get replaced.)
- **Per level (1–99): 5 stat points.** The class auto-allocates **1–3** to its core stats
  (specified per class, e.g. `+2 str, +1 con`); the player freely allocates the remaining
  **2–4** into any of the 8 stats (may double up on core). WoW-style gain tables are retired.
- **Starting baseline:** each class begins with a suitable starting stat block, generated
  per class from its identity (races layer in later).

### Class model (decided)
- **Hybrid** class/species relationship: some classes shared, some species-specific (later).
- Roster: ~a dozen to start, growing to dozens.
- Built around **1–3 core stats** (of the 8 primaries).
- A class definition = **name · armor tier · core stats · guaranteed level-up allocation ·
  skills**. (Races and specific abilities handled later.)

### Armor tiers (decided)
`clothing < light armor < medium armor < heavy armor`. Each class has one designated tier
and may equip that tier and any lower. No level-gated unlocks. (Replaces cloth/leather/mail/plate.)

### Resources (decided)
Four resources: **mana, rage, stamina, combo points** (the "yellow bar" resource was renamed
from *energy* → *stamina*, since stamina is no longer a stat and `energy` is now a damage
school). Classes may **mix and match** (e.g. rage+mana, mana+combo, stamina+combo). Per-class
resource assignments come with each class or the abilities pass.

### Skills (design)
All skills — weapon skills, magic skills (Pyromancy, Energetics, …), and professions — are
**normalized to max level 99**, like character level.

- **Abilities are learned through skills, not class/character level.** Leveling a class grants
  no abilities; abilities unlock by reaching skill levels in the relevant skill (an Elementalist
  gains abilities by leveling Energetics or Staves, never by leveling "Elementalist").
- **Weapon skills gate weapon equipping** — the weapon skills a character has determine which
  weapon types they can equip (replaces the current permissive weapon gating in equipment.js).
- **Leveling is XP-based.** Each skill accrues its own XP and levels to 99 on a curve — not the
  classic skill-up-on-use model, and not skill-point spending.
- **Two XP tracks.** Killing enemies and completing quests grant **character XP** (→ level →
  stat points, unchanged). Performing a skill's actions grants that **skill's XP** (→ skill
  level → abilities) — e.g. casting a Staves ability raises Staves; mining a node raises Mining.
- **Professions** keep their function (gathering, crafting, recipes) wholly intact, but their
  **leveling converts from skill-up to XP-based** to fit the unified 99 scale. In the **UI**,
  professions display alongside all other skills, optionally split under a Combat / Non-combat header.
- **Storage:** skills live on the instance (`inst.skills`, a unified skillId → level map, as
  professions already do).
- **Data:** a new **`skills.json`** will likely define each skill (id, name, combat/non-combat
  category, XP curve, and the abilities it grants at which skill levels). Abilities reference
  their skill + required skill level.

- **Trainable skills.** A character can train **only the skills in its class list** — plus any
  **unlocked** skills granted later by special/narrative events (e.g. "touched by the fires of
  Trael → gains Divine Fire"). The data model allows a character to hold skills beyond its class
  list (`inst.skills` + an unlocked-skills mechanism).

_To tune later: per-skill XP curves/rates, and starting skill levels (assume level 1 unless noted)._

**Built so far (testing scaffold):** `Data/skills.json` created — every skill across the 5 classes,
categorized (combat / non-combat), with the 14 weapon skills mapped to their `weaponTypes` and each
granting **`basic_attack`** at level 1. A Galanova `basic_attack` ability (clone of the old melee
attack, no rage gain) was added to `abilities.json`, and combat now **defaults to `basic_attack`** so
the 5 classes can fight while the rest of the skills system is built. Verified: an Armsman wins a
combat sim using basic_attack.

**Universal skills** — every class has these (not listed per class):
- **Riding** — converted from an account-wide skill to **per-character**. For escape
  calculations, the **party average** of all members' riding is used.
- **Trading** — the primary interaction point of **charisma**; governs buy/sell prices.
  The **party average** of all members' trading is what applies.
- **Dungeoneering** — held by every class; the party's backup sense for **traps**.
  Traps appear in dungeons (`forcedEncounterQueue` `trap` entries) and in the world
  (encounter-table `trap` slots), each referencing a trap template in `Data/traps.json`.
  On encounter, **each living member rolls to detect**: first a `classLevel/100`
  chance, then — only if that fails — a `dungeoneeringLevel/100` backup chance. The
  trap is avoided if **any** member detects it. **Every** living member gains
  dungeoneering XP for the encounter, detected or not. An undetected trap fires its
  configured `effect` (damage by default; `target: party | random`).

### Systems to build (engineering to-do)
- ✅ **Class schema** — `armorTier`, `coreStats`, `guaranteedLevelUp`, `resources[]`,
  `skills[]`, `startingBaseline`; 5 classes written to `classes.json`; races decoupled (empty).
- ✅ **Stat-point allocation** — 5/level, class-guaranteed (1–3) + free (2–4), cap at L99;
  `leveltables.js` rewritten (startingStats / addXpToInst / allocateStat / newInstance);
  HP from `con`, mana from `int`; gain tables retired.
- ✅ **maxLevel 99** — `maxLevel 99`; xpTable generated (quadratic) in leveltables.
- ✅ **Armor-tier rename** — `equipment.js` rebuilt to clothing<light<medium<heavy ladder
  (+ legacy cloth/leather/mail/plate → tier mapping for un-migrated item data).
- ✅ **Resource mix-and-match** — `buildResources(classId,maxMana)` reads each class's list;
  combatbridge/gameplayloop hardcoded branches removed.
- ✅ **Allocation UI + character-sheet updates** — character sheet shows unspent points with
  per-stat `+` allocation controls (App→`allocateStat` IPC→`session.allocateStat`→persist);
  resource bars (sheet + CombatView) driven by each class's resource list; WoW-class UI
  constants retired (now read `classes.json`). raceId made nullable for decoupled races.
- ✅ **Skills system** — `Engine/skills.js` (XP curve to 99, `addSkillXp`, `abilitiesFromSkills`,
  weaponType↔skill maps, `canEquipWeaponType`, unlockable skills via `grantSkill`). Starting
  skills = class list + universal (riding/trading/dungeoneering). Combat derives abilities from skills;
  professions converted to XP-based; skills UI panel (combat/non-combat, XP bars).
  **Per-action combat skill XP:** both auto-combat (`run`/`runEncounter`) and manual combat
  (`startCombat`/`stepTurn`/`executePlayerAction`) track each party member's ability uses and
  award XP to each ability's skill through the shared `RewardEngine.apply` (basic_attack → the
  equipped weapon's skill). _Tune-later: XP rates/curves; magic/profession ability tables (need
  authored Galanova abilities); single-`inst.profession` gating retained._
- ✅ **Weapon equip gating** — enforced in `equipItem` via weapon skills. _(Offhand still permissive.)_

### Open / TBD — do not invent
- **Race / species roster** — new lineup ("ever-growing roster of species").
- **Factions / reputation**, zones, professions, companions — to be re-themed.

---

## Class roster (work in progress)

> Captured from the author. Abilities, species access, and final stat tuning come later.
> Starting baselines are generated to fit the class (~80 pts, floor 8, core stats raised)
> and are first-pass numbers to tune when the stat-allocation system is built.
>
> **Initial testing set: 5 classes** — Armsman, Illusionist, Elementalist, Assassin,
> Survivalist. Paused here intentionally: enough for testing and a representative spread of
> armor tiers, resource mixes, and skills to build the systems against.

### Armsman
- **Armor:** Heavy
- **Core stats:** Dex, Con, Wis
- **Guaranteed level-up:** +1 Dex, +1 Con, +1 Wis (3 of the 5 points; player allocates the other 2)
- **Resources:** stamina, combo points
- **Skills:** Blacksmithing, Engineering, Dueling, one-handed swords, two-handed swords,
  one-handed axes, two-handed axes, one-handed maces, two-handed maces, daggers, polearms,
  guns, bows, crossbows, thrown
  - _Note: Blacksmithing & Engineering are professions (function separately per the
    professions rule); to reconcile in the skills/professions pass._
- **Starting baseline (generated — tune later):** str 13 · dex 15 · con 15 · int 8 · spi 9 · wis 13 · spd 10 · cha 9

### Illusionist
- **Armor:** Clothing
- **Core stats:** Int, Cha
- **Guaranteed level-up:** +1 Int, +1 Cha (2 of the 5 points; player allocates the other 3)
- **Resources:** mana
- **Skills:** staves, wands, daggers, manipulation, madness, morale, enchanting, alchemy
  - _Note: Enchanting & Alchemy are professions; reconcile in the skills/professions pass._
- **Starting baseline (generated — tune later):** str 8 · dex 10 · con 9 · int 16 · spi 12 · wis 10 · spd 11 · cha 15

### Elementalist
- **Armor:** Clothing
- **Core stats:** Int, Spi
- **Guaranteed level-up:** +2 Int, +1 Spi (3 of the 5 points; player allocates the other 2)
- **Resources:** mana
- **Skills:** Pyromancy, Cryomancy, Geomancy, Energetics, Hydromancy, Enchanting, Staves, Wands
  - _Note: Enchanting is a profession; reconcile in the skills/professions pass._
- **Starting baseline (generated — tune later):** str 8 · dex 9 · con 9 · int 17 · spi 14 · wis 11 · spd 10 · cha 10

### Assassin
- **Armor:** Light
- **Core stats:** Dex, Spd, Cha
- **Guaranteed level-up:** +1 Dex, +1 Spd, +1 Cha (3 of the 5 points; player allocates the other 2)
- **Resources:** stamina, combo points
  - _Note: author wrote "energy" — recorded as **stamina** (the renamed yellow-bar resource); confirm if otherwise._
- **Skills:** Subtlety, Poisons, daggers, Manipulation, Lockpicking, Alchemy
  - _Note: Alchemy is a profession; reconcile in the skills/professions pass._
- **Starting baseline (generated — tune later):** str 10 · dex 15 · con 10 · int 8 · spi 8 · wis 9 · spd 15 · cha 13

### Survivalist
- **Armor:** Medium
- **Core stats:** Con, Spi, Spd
- **Guaranteed level-up:** +1 Con, +1 Spi, +1 Spd (3 of the 5 points; player allocates the other 2)
- **Resources:** stamina, mana
- **Skills:** Biomancy, Fishing, Mining, Herbalism, Woodcutting, First Aid, Cooking, polearms,
  one-handed axes, two-handed axes, bows, daggers
  - _Note: Fishing, Mining, Herbalism, Woodcutting, First Aid, Cooking are professions;
    reconcile in the skills/professions pass._
- **Starting baseline (generated — tune later):** str 12 · dex 12 · con 14 · int 9 · spi 13 · wis 11 · spd 13 · cha 8

---

## Race / species roster (work in progress)

> Races apply **flat stat modifiers at character creation** (`statMod` in `races.json` →
> `races`), applied by `leveltables.raceStatMod` / `newInstance` and baked into the instance's
> `stats.raw`. `raceId` is otherwise decoupled from stats. More races to come.

### Sephir
- **statMod:** −1 str, −1 con, +2 int
- Blue-skinned, six-eyed humanoids of Meyn-Sephir (see *The Galaxy*). **Lati Ashera's race.**

---

## Starter content (playable MVP)

The first playable slice, seeded into `slot_start`:
- **Lati Ashera** — level 1 **Sephir Illusionist** (`instances/companions/player_main`,
  `isPlayer`), all illusionist skills + universal riding/trading at level 1; abilities derive
  from skills (currently just `basic_attack` from her weapon skills). With the Sephir mod her
  stats are `str 7 · dex 10 · con 8 · int 18 · spi 12 · wis 10 · spd 11 · cha 15` → HP 80 /
  MP 270. Starts with a **Basic Utility Knife** (dagger, `basic_utility_knife`) equipped, so
  her Basic Attack trains the **daggers** skill.
- **Colonial Sewers** (`templates/zones/colonial_sewers`, region `rath`) — the only seeded zone
  (the WoW world map was stripped in Phase 6/7); `enc_colonial_sewers` combat pool = sewer rat +
  tunnel roach.
- **Tunnel Roach** / **Colonial Sewer Rat** (`mobs.json`) — level 1 beasts, `basic_attack` only,
  Galanova stat keys, with per-creature `butcheryLoot` (meat/bone, + hide on the rat) and
  `butcheryXp`. Verified: Lati defeats one in ~6 turns.

---

## Conversion Plan (phase overview)

0. **Re-point repo** to the new `galanova_adventure` remote. ✅ done
1. **Permanent memory + this design doc** stood up. ✅ done
2. **Universe bible** — lore, factions, naming, element taxonomy. ✅ (gods, galaxy, schools)
3. **Systems redesign spec** — stats, resources, formulas. ✅
4. **Implement redesigned systems** — stats (8), resources, schools (9), dodge, armor tiers,
   stat-point allocation (cap 99), skills system + XP, equip gating. ✅
5. **Classes & races** — 5 classes; Sephir race; skills/abilities-from-skills; **playable MVP**
   (Lati Ashera in Colonial Sewers vs tunnel roaches). ✅
6. **Clear bulk data to templates** — one example per category, structure preserved. ✅
   (mobs/items/quests/dungeons/shop/companions/professions reduced to MVP-or-template entries;
   datalayer test fixtures preserved). `abilities.json` intentionally left WoW for now.
7. **Rebrand & cleanup** — strip remaining WoW/Kalimdor/thazz strings. ✅ (engine + UI; see build log)
8. **Final validation** — tests + app smoke test. ✅ (`npm test` harness, ~246/246 green)

---

## Build log — Phases 6–8 + systems (session 2)

**Data templated (Phase 6).** Each `Data/` bulk file reduced to one example: the Galanova MVP
entry where it exists (`tunnel_roach`, `basic_utility_knife`, `enc_colonial_sewers`) else a neutral
`template_*` placeholder. Datalayer test fixtures (`enemy_test_grunt`/`enemy_test_caster`/
`encounter_test_plains`/`quest_test_01`) kept so the self-test stays green.

**Rebrand / dead-code cleanup (Phase 7).**
- Deleted orphaned WoW modules `Engine/classes.js` and `Engine/combatbridge.js` (superseded by
  `equipment.js` / gameplayloop's own `CombatBridge`). Removed dead `classRestrictions`.
- Defaults `orc→sephir`, `warrior→armsman`; legacy `CLASS_BASE_HP/MP` 9-class maps → `{}`;
  `STARTER_GEAR → {}`; `raw.sta → raw.con`. `Kalimdor RPG → Galanova` (headers, welcome, UI logo);
  `package.json` name → `galanova_adventure`.
- **`skinning → butchery`** full rename (`Data/butchery.json`, profession id, IPC `game:butcherCorpses`,
  UI `canButcher`/"Butcher").
- **World/travel:** 130+ hardcoded WoW zones in `seed()` stripped — only `colonial_sewers` (Rath)
  remains. The `connectedZones` adjacency graph removed entirely; travel = **same-region free,
  cross-region pays `max(100, destLevel×10)`** (UI list renamed `connectedZones → travelZones`).

**Systems added/changed.**
- **Combat pets → skills, not class.** `PETS_BY_SKILL` (Zoology→`zoology.json`, Summoning→
  `summoning.json`) + `petsForUnit(inst)`; a companion draws from every pet skill it has learned.
- **Butchery loot = per-creature & typed.** Each mob authors `butcheryLoot: [{type, itemId, chance,
  qty|minQty/maxQty}]` (types **meat / hide / bone / feather** — a feathered creature carries
  `feather` entries and no `hide`) plus `butcheryXp`. Old global leather/hide tier tables gone;
  `butchery.json` is now schema reference only. Example loot on the rat/roach; material items
  `thin_hide`/`small_bone`/`down_feather` added.
- **Professions level via authored XP, not skill-up.** `awardProfessionXp(save, prof, xp)`: crafting
  uses `recipe.xp`, gathering `node.xp`, butchering `mob.butcheryXp` (fallback `10 + minSkillLevel`).
  The old `skillGain`/`skillGainTiers` chance-roll is gone.
- **Item suffixes → 8 Galanova stats.** `item_suffixes.json` rebuilt: 8 single-stat suffixes +
  11 stat-descriptive paired suffixes (of the Brute/Fighter/Skirmisher/…); `statCost` flat 1.0.
  Separate `craftRollChance` (vs loot `rollChance`) wired into `craftItem` — crafted output can roll
  a suffix when the item is `randomEnchant`-tagged. System is **dormant** until items carry the tag.

**Testing (Phase 8).** `Testing/run_tests.js` rewritten as a harness that runs each system's own
self-test and aggregates (`npm test`): DATA LAYER, CLASS/ARMOR, ITEM SUFFIXES, SKILLS, ENCOUNTERS,
DUNGEONS, GAME LOOP → **~246/246, all green**. The old ~1880-line WoW class-ability suites were
deleted. Self-tests in datalayer + gameplayloop now run **only** under `GALANOVA_RUN_TESTS` (set by
the harness) — the app no longer runs tests on launch. Fixed a latent `partySkillLevel` bug (now
uses `getSkillLevel`, handling the `{level,xp}` skill form).

**Still WoW (intentional):** `abilities.json` + its combat `PASSIVE_HOOKS` (blood_fury/war_stomp/…)
— next conversion target.
