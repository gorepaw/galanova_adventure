// =============================================================================
// STORY / COMMUNE LAYER — Galanova
// The "Commune" storyline system: a persistent scene queue carried on the save,
// plus pure helpers to resolve the current dialogue node into a UI view-model,
// advance/choose through it, and apply a node's effects. Combat-driven triggers
// (win counter → stage scenes) also live here so the Session stays thin.
//
// Save fields used (all optional; save schema is OPEN):
//   save.sceneQueue   — [{ dialogueId, nodeId }]  (head is the active scene)
//   save.seenScenes   — [dialogueId, …]           (one-shot guard)
//   save.storyCounters— { <key>: number }         (e.g. encounter-win tallies)
//
// See Docs/GALANOVA.md "Storyline Quests & the Commune system".
// =============================================================================

import { Loader, Modifiers } from "./datalayer.js";
import type { SceneNodeVM } from "./types/viewmodel.js";

export interface SceneEffect { type: string; [k: string]: any }
interface QueuedScene { dialogueId: string; nodeId: string }

const loadDialogue = (id: string): any => {
  const r = Loader.load(`templates/dialogues/${id}`, "dialogue");
  return r.ok ? r.data : null;
};
const loadSpeaker = (id: string): any => {
  if (!id) return null;
  const r = Loader.load(`templates/speakers/${id}`, "speaker");
  return r.ok ? r.data : null;
};
const findNode = (dlg: any, nodeId: string): any =>
  (dlg?.nodes || []).find((n: any) => n.id === nodeId) || null;

export const hasPendingScene = (save: any): boolean =>
  Array.isArray(save?.sceneQueue) && save.sceneQueue.length > 0;

// Push a scene onto the queue. Skips it if already seen or already queued (unless
// `force`). Returns a new save (or the same save when nothing changed).
export const enqueueScene = (save: any, dialogueId: string, opts: { force?: boolean } = {}): any => {
  const dlg = loadDialogue(dialogueId);
  if (!dlg || !dlg.nodes?.length) return save;
  const seen: string[] = save.seenScenes || [];
  const queue: QueuedScene[] = save.sceneQueue || [];
  if (!opts.force && seen.includes(dialogueId)) return save;
  if (queue.some(q => q.dialogueId === dialogueId)) return save;
  return { ...save, sceneQueue: [...queue, { dialogueId, nodeId: dlg.nodes[0].id }] };
};

// Resolve the head of the queue into a UI view-model, or null if none.
export const resolvePendingScene = (save: any): SceneNodeVM | null => {
  if (!hasPendingScene(save)) return null;
  const head: QueuedScene = save.sceneQueue[0];
  const dlg = loadDialogue(head.dialogueId);
  if (!dlg) return null;
  const node = findNode(dlg, head.nodeId);
  if (!node) return null;
  const sp = loadSpeaker(node.speaker);
  const choices = (node.choices || []).map((c: any, i: number) => ({ index: i, label: c.label }));
  const isLast = !choices.length && (node.next == null);
  return {
    dialogueId: dlg.id,
    channel: dlg.channel || "personal_log",
    nodeId: node.id,
    speaker: sp
      ? { id: sp.id, name: sp.name, accent: sp.accent, silhouette: sp.silhouette, rune: sp.rune }
      : null,
    text: node.text || "",
    hint: node.hint || null,
    choices,
    isLast,
  };
};

// Advance the current node (optionally via a choice index). Returns the new save,
// the effects that fired, and whether the scene ended. Pure w.r.t. the save; the
// caller persists and applies effects.
export const advanceScene = (
  save: any,
  choiceIndex?: number,
): { save: any; effects: SceneEffect[]; sceneEnded: boolean } => {
  if (!hasPendingScene(save)) return { save, effects: [], sceneEnded: false };
  const queue: QueuedScene[] = save.sceneQueue.slice();
  const head = queue[0];
  const dlg = loadDialogue(head.dialogueId);
  const node = dlg ? findNode(dlg, head.nodeId) : null;
  if (!node) { // corrupt/missing — drop the scene so we never get stuck
    queue.shift();
    return { save: { ...save, sceneQueue: queue }, effects: [], sceneEnded: true };
  }

  let effects: SceneEffect[] = [];
  let nextNodeId: string | null = null;
  if (node.choices?.length) {
    const idx = typeof choiceIndex === "number" ? choiceIndex : 0;
    const choice = node.choices[idx] || node.choices[0];
    effects = choice.effects || [];
    nextNodeId = choice.next ?? null;
  } else {
    effects = node.effects || [];
    nextNodeId = node.next ?? null;
  }

  if (nextNodeId == null) {
    queue.shift();
    const seen: string[] = save.seenScenes || [];
    const newSave = {
      ...save,
      sceneQueue: queue,
      seenScenes: seen.includes(head.dialogueId) ? seen : [...seen, head.dialogueId],
    };
    return { save: newSave, effects, sceneEnded: true };
  }
  queue[0] = { ...head, nodeId: nextNodeId };
  return { save: { ...save, sceneQueue: queue }, effects, sceneEnded: false };
};

// Give the current story quest a fresh objective map (used by assignQuest).
const assignQuest = (save: any, questId: string): any => {
  if (!questId || save.quests?.[questId]) return save;
  const r = Loader.load(`templates/quests/${questId}`, "quest");
  const objectives: Record<string, number> = {};
  if (r.ok) for (const obj of (r.data.objectives || [])) objectives[obj.id] = 0;
  return {
    ...save,
    quests: {
      ...(save.quests || {}),
      [questId]: { objectives, completed: false, assignedAt: new Date().toISOString() },
    },
  };
};

const applyReward = (save: any, eff: any, log: string[]): any => {
  let s = save;
  if (eff.currency) { s = { ...s, currency: (s.currency || 0) + eff.currency }; log.push(`   Reward: +${eff.currency}c`); }
  for (const it of (eff.items || [])) {
    s = Modifiers.addToInventory(s, it.itemId, it.qty || 1);
    log.push(`   Reward: ${it.qty || 1}x ${it.itemId}`);
  }
  // XP rewards need per-instance leveling (Session-side) — deferred to a later slab.
  return s;
};

// Apply the "pure" scene effects that only touch the save. Effects that need
// Session state (startCombat, travel) are returned in `deferred` for the caller.
export const applyEffects = (
  save: any,
  effects: SceneEffect[],
): { save: any; deferred: SceneEffect[]; log: string[] } => {
  let s = save;
  const deferred: SceneEffect[] = [];
  const log: string[] = [];
  for (const eff of effects || []) {
    switch (eff.type) {
      case "setFlag":       s = Modifiers.setFlag(s, eff.flag, eff.value ?? true); break;
      case "assignQuest":   s = assignQuest(s, eff.questId); break;
      case "completeQuest": s = Modifiers.completeQuest(s, eff.questId); log.push(`   ✓ Quest complete: ${eff.questId}`); break;
      case "giveReward":    s = applyReward(s, eff, log); break;
      case "startCombat":
      case "travel":        deferred.push(eff); break;
      default: break;
    }
  }
  return { save: s, deferred, log };
};

// Iterate active story quests in the current zone (the common guard).
function* activeStoryQuests(save: any): Generator<[string, any, any]> {
  for (const [questId, qstate] of Object.entries<any>(save.quests || {})) {
    if (qstate?.completed) continue;
    const r = Loader.load(`templates/quests/${questId}`, "quest");
    if (!r.ok || r.data.type !== "story") continue;
    if (r.data.zoneId && save.currentZone !== r.data.zoneId) continue;
    yield [questId, qstate, r.data];
  }
}

// On a combat victory in a story quest's zone: bump its win counter and enqueue the
// scene the new count unlocks — the (retry-aware) boss scene at its threshold, else
// any `onStage` beat. The boss scene's own startCombat effect starts the fight when
// the player advances through it (Session-side). Returns new save.
export const onStoryCombatVictory = (save: any): any => {
  let s = save;
  for (const [, , quest] of activeStoryQuests(s)) {
    const script = quest.script || {};
    const counterKey = script.counter || `${quest.id}_wins`;
    const next = ((s.storyCounters || {})[counterKey] || 0) + 1;
    s = { ...s, storyCounters: { ...(s.storyCounters || {}), [counterKey]: next } };

    // Boss threshold (lowered once the boss has been attempted) beats stage scenes.
    const attempted = script.attemptedFlag ? !!s.flags?.[script.attemptedFlag] : false;
    const bossThreshold = attempted ? (script.bossRetryAt ?? script.bossAt) : script.bossAt;
    if (bossThreshold && next === bossThreshold && script.bossScene) {
      s = enqueueScene(s, script.bossScene, { force: true });
      continue;
    }
    for (const stage of (quest.onStage || [])) {
      if (stage.at === next && stage.dialogueId) s = enqueueScene(s, stage.dialogueId);
    }
  }
  return s;
};

// A boss kill (enemy id matches an active story quest's script.bossId) enqueues that
// quest's completion scene. Returns whether a boss was defeated so the caller can
// skip the ordinary win-counter path for the same combat.
export const onStoryBossDefeated = (save: any, kills: any[] = []): { save: any; defeated: boolean } => {
  let s = save;
  let defeated = false;
  const killedIds = new Set((kills || []).map((k: any) => k?.id).filter(Boolean));
  for (const [, , quest] of activeStoryQuests(s)) {
    const bossId = quest.script?.bossId;
    if (bossId && killedIds.has(bossId)) {
      defeated = true;
      s = { ...s, flags: { ...(s.flags || {}), pendingStoryBoss: null } };
      const victory = quest.onComplete || quest.script?.victoryScene;
      if (victory) s = enqueueScene(s, victory, { force: true });
    }
  }
  return { save: s, defeated };
};

// A wipe during a story arc resets its win counter and queues the right rez scene
// (boss vs. tunnels). `wasBoss` comes from the encounter's _storyBoss marker.
export const onStoryWipe = (save: any, wasBoss: boolean): any => {
  let s = save;
  for (const [, , quest] of activeStoryQuests(s)) {
    const script = quest.script || {};
    const counterKey = script.counter || `${quest.id}_wins`;
    s = { ...s, storyCounters: { ...(s.storyCounters || {}), [counterKey]: 0 } };
    // Clear any pending boss surface; the retry re-enqueues the discovery scene at
    // the lowered threshold, which starts the fight afresh.
    s = { ...s, flags: { ...(s.flags || {}), pendingStoryBoss: null } };
    const scene = wasBoss ? script.bossRezScene : script.rezScene;
    if (scene) s = enqueueScene(s, scene, { force: true });
  }
  return s;
};
