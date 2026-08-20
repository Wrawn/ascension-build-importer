// Tiny append-on-import build store, backed by a single JSON file.
//
// Every successful import is recorded (upserted by character identity), so the
// server accumulates a roster of every build anyone has imported through this
// instance. Point DATA_DIR at a mounted volume so it survives image updates.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const FILE = join(DATA_DIR, "builds.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
// Upper bounds so unauthenticated imports can't grow the files without limit.
const MAX_BUILDS = Number(process.env.MAX_BUILDS || 2000);
const MAX_GROUPS = Number(process.env.MAX_GROUPS || 300);

const clampStr = (s, n) => String(s == null ? "" : s).slice(0, n);

let cache = null; // Map<key, record>
let loading = null;
let writeChain = Promise.resolve(); // serialize writes

async function ensureLoaded() {
  if (cache) return;
  if (!loading) {
    loading = (async () => {
      await mkdir(DATA_DIR, { recursive: true });
      try {
        const txt = await readFile(FILE, "utf8");
        const arr = JSON.parse(txt);
        cache = new Map(arr.map((r) => [r.key, r]));
      } catch {
        cache = new Map(); // no file yet, or unreadable -> start fresh
      }
    })();
  }
  await loading;
}

// Atomic-ish write: write temp then rename, serialized so concurrent imports
// don't interleave.
function persist() {
  writeChain = writeChain.then(async () => {
    const arr = [...cache.values()];
    const tmp = FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(arr, null, 2));
    await rename(tmp, FILE);
  });
  return writeChain;
}

// Identity = character + build content. A character can have several distinct
// builds (respecs); re-importing an *identical* build lands on the same key and
// updates rather than duplicating.
export function buildKey({ characterId, name, fingerprint }) {
  const who = characterId
    ? "id:" + characterId
    : "name:" + String(name || "unknown").trim().toLowerCase();
  if (!fingerprint) return who;
  const fp = createHash("sha1").update(String(fingerprint)).digest("hex").slice(0, 12);
  return who + "#" + fp;
}

export async function recordBuild(rec) {
  await ensureLoaded();
  const now = new Date().toISOString();
  // Don't let an absent label wipe a name the user set earlier.
  const patch = { ...rec };
  if (patch.label == null || patch.label === "") delete patch.label;
  else patch.label = clampStr(patch.label, 120);
  if (patch.name != null) patch.name = clampStr(patch.name, 80);

  const existing = cache.get(rec.key);
  // Cap total distinct builds so imports can't fill the disk. Existing entries
  // still update; only brand-new keys are refused once full.
  if (!existing && cache.size >= MAX_BUILDS) {
    throw new Error("Build roster is full (" + MAX_BUILDS + ").");
  }
  if (existing) {
    Object.assign(existing, patch, {
      firstSeen: existing.firstSeen,
      lastImported: now,
      importCount: (existing.importCount || 1) + 1,
    });
  } else {
    cache.set(rec.key, {
      label: "",
      ...patch,
      firstSeen: now,
      lastImported: now,
      importCount: 1,
    });
  }
  await persist();
  return cache.get(rec.key);
}

export async function setLabel(key, label) {
  await ensureLoaded();
  const rec = cache.get(key);
  if (!rec) return null;
  rec.label = String(label || "").slice(0, 120);
  await persist();
  return rec;
}

export async function deleteBuild(key) {
  await ensureLoaded();
  const had = cache.delete(key);
  if (had) await persist();
  return had;
}

export async function listBuilds() {
  await ensureLoaded();
  return [...cache.values()].sort((a, b) =>
    (b.lastImported || "").localeCompare(a.lastImported || "")
  );
}

export async function getBuild(key) {
  await ensureLoaded();
  return cache.get(key) || null;
}

// ---------------------------------------------------------------------------
// Raid groups (a whole report's roster of builds, saved together)
// ---------------------------------------------------------------------------

let groupsCache = null; // Map<key, group>
let groupsLoading = null;
let groupsWriteChain = Promise.resolve();

async function ensureGroupsLoaded() {
  if (groupsCache) return;
  if (!groupsLoading) {
    groupsLoading = (async () => {
      await mkdir(DATA_DIR, { recursive: true });
      try {
        const arr = JSON.parse(await readFile(GROUPS_FILE, "utf8"));
        groupsCache = new Map(arr.map((g) => [g.key, g]));
      } catch {
        groupsCache = new Map();
      }
    })();
  }
  await groupsLoading;
}

function persistGroups() {
  groupsWriteChain = groupsWriteChain.then(async () => {
    const tmp = GROUPS_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify([...groupsCache.values()], null, 2));
    await rename(tmp, GROUPS_FILE);
  });
  return groupsWriteChain;
}

// A group is keyed by its report so re-importing the same raid updates it.
export async function recordGroup(group) {
  await ensureGroupsLoaded();
  const now = new Date().toISOString();
  const existing = groupsCache.get(group.key);
  if (!existing && groupsCache.size >= MAX_GROUPS) {
    throw new Error("Group list is full (" + MAX_GROUPS + ").");
  }
  if (existing) {
    Object.assign(existing, group, {
      label: group.label != null && group.label !== "" ? group.label : existing.label,
      firstSeen: existing.firstSeen,
      lastImported: now,
      importCount: (existing.importCount || 1) + 1,
    });
  } else {
    groupsCache.set(group.key, {
      label: "",
      ...group,
      firstSeen: now,
      lastImported: now,
      importCount: 1,
    });
  }
  await persistGroups();
  return groupsCache.get(group.key);
}

export async function setGroupLabel(key, label) {
  await ensureGroupsLoaded();
  const g = groupsCache.get(key);
  if (!g) return null;
  g.label = String(label || "").slice(0, 120);
  await persistGroups();
  return g;
}

export async function deleteGroup(key) {
  await ensureGroupsLoaded();
  const had = groupsCache.delete(key);
  if (had) await persistGroups();
  return had;
}

export async function listGroups() {
  await ensureGroupsLoaded();
  return [...groupsCache.values()].sort((a, b) =>
    (b.lastImported || "").localeCompare(a.lastImported || "")
  );
}
