// Ascension Build Importer — self-hosted web app.
//
// Serves the ascension.nie.one builder with a "Fetch from Darkmoon log" widget
// injected, and exposes /api/build which does the Darkmoon lookup + conversion
// server-side (where the same-origin Referer the API requires is trivial to set,
// and cross-origin/CORS limits don't apply).
//
// Zero runtime dependencies — Node 18+ built-ins only (http, fetch, fs, crypto).
//
// Hardening for public exposure (see SECURITY.md):
//   - ADMIN_TOKEN gates the roster (view + rename + delete) so only you manage it
//   - per-IP rate limiting on every request
//   - the build store is capped so imports can't fill the disk
//   - static serving is basename-only; the upstream proxy is extension-allowlisted
// You should STILL front it with an authenticating reverse proxy for real access
// control (Cloudflare Access, Authelia, or Basic Auth). Details in SECURITY.md.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  extractCatalog,
  parseCharacter,
  buildResult,
  parseTarget,
  roleFromSpec,
} from "./lib/convert.js";
import {
  recordBuild,
  listBuilds,
  setLabel,
  deleteBuild,
  buildKey,
  recordGroup,
  listGroups,
  setGroupLabel,
  deleteGroup,
  normBucket,
  getBuild,
} from "./lib/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const BUILDER_ORIGIN = process.env.BUILDER_ORIGIN || "https://ascension.nie.one";
const LOGS_ORIGIN =
  process.env.LOGS_ORIGIN || "https://darkmoon.ascensionlogs.gg";
const BUILDER_TTL_MS = Number(process.env.BUILDER_TTL_MS || 6 * 60 * 60 * 1000);

// Secret that protects roster view + management. Empty = open (fine on a LAN).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// Rate limiting (per client IP, fixed window).
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.RATE_MAX || 120);
// Trust X-Forwarded-For (you'll be behind a reverse proxy). Set TRUST_PROXY=0
// if the app is directly internet-facing so a client can't spoof its IP.
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";

// Only these files are ever served from disk.
const STATIC_ALLOW = new Set(["widget.js", "widget.css", "builds.html"]);
const STATIC_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};
// The builder only pulls static assets at runtime; the proxy refuses anything
// that isn't an obvious asset, so it can't be used as a general web proxy.
const ASSET_RE = /\.(webp|png|jpe?g|gif|svg|ico|css|js|map|woff2?|ttf)$/i;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
};

// ---------------------------------------------------------------------------
// Builder page: fetch, inject our widget, cache alongside the parsed catalog.
// ---------------------------------------------------------------------------

let builderCache = null;
let builderInflight = null;

const WIDGET_TAG =
  '<link rel="stylesheet" href="/_abi/widget.css">' +
  '<script src="/_abi/widget.js" defer></script>';

function injectWidget(html) {
  const idx = html.lastIndexOf("</body>");
  if (idx < 0) return html + WIDGET_TAG;
  return html.slice(0, idx) + WIDGET_TAG + html.slice(idx);
}

async function loadBuilder(force = false) {
  if (!force && builderCache && Date.now() - builderCache.fetchedAt < BUILDER_TTL_MS) {
    return builderCache;
  }
  if (builderInflight) return builderInflight;

  builderInflight = (async () => {
    try {
      const res = await fetch(BUILDER_ORIGIN + "/", { cache: "no-cache" });
      if (!res.ok) throw new Error("Builder returned HTTP " + res.status);
      const raw = await res.text();
      const catalog = extractCatalog(raw);
      builderCache = { html: injectWidget(raw), catalog, fetchedAt: Date.now() };
      return builderCache;
    } catch (err) {
      if (builderCache) return builderCache; // serve stale on failure
      throw err;
    } finally {
      builderInflight = null;
    }
  })();
  return builderInflight;
}

// ---------------------------------------------------------------------------
// Darkmoon fetches (server-side: we set the Referer the API demands).
// ---------------------------------------------------------------------------

function logsFetch(path) {
  return fetch(LOGS_ORIGIN + path, {
    headers: { Referer: LOGS_ORIGIN + "/", Accept: "application/json" },
  });
}

async function fetchCharacter(target) {
  if (target.kind === "name") {
    const byName = await logsFetch(
      "/api/armory/by-name/" + encodeURIComponent(target.value)
    ).then((r) => r.json());
    if (!byName || !byName.success || !byName.character) {
      throw new Error('Character "' + target.value + '" was not found.');
    }
    if (!byName.has_armory) {
      throw new Error('"' + byName.character.name + '" has no armory capture yet.');
    }
    const char = await logsFetch(
      "/api/armory/character/" + byName.character.id
    ).then((r) => r.json());
    return { char, name: byName.character.name, id: byName.character.id };
  }
  const char = await logsFetch(
    "/api/armory/character/" + encodeURIComponent(target.value)
  ).then((r) => r.json());
  if (!char || !char.success) {
    throw new Error("No build capture available for character #" + target.value + ".");
  }
  const player = char.ci_resolved && char.ci_resolved.player;
  const name =
    (player && typeof player === "object" ? player.name : player) ||
    (char.character && char.character.name) ||
    "#" + target.value;
  return { char, name, id: target.value };
}

// Run async fn over items with bounded concurrency.
async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Fetch a report's roster (deduped players across all encounters) plus the
// zone / difficulty / date used to name the group.
async function fetchRaidRoster(reportId) {
  const meta = await logsFetch(
    "/api/reports/" + encodeURIComponent(reportId) + "/encounters"
  ).then((r) => r.json());
  if (!meta || !meta.success) throw new Error("Report not found or not accessible.");
  const encounters = meta.encounters || [];
  if (!encounters.length) throw new Error("This report has no encounters.");
  const report = meta.report || {};

  const zoneCounts = {};
  for (const e of encounters) {
    const z = e.zone || e.instance_name;
    if (z && z !== "Unknown") zoneCounts[z] = (zoneCounts[z] || 0) + 1;
  }
  const zone =
    Object.keys(zoneCounts).sort((a, b) => zoneCounts[b] - zoneCounts[a])[0] ||
    report.zone ||
    "Unknown";

  // Players can respec between fights, so tally each player's spec across all
  // encounters and use their *predominant* spec (their main role) rather than
  // whichever fight we happened to read first.
  const encIds = encounters.map((e) => e.id).slice(0, 40);
  const roster = new Map(); // id -> { id, name, specCounts }
  await mapLimit(encIds, 8, async (eid) => {
    try {
      const p = await logsFetch(
        "/api/reports/" + reportId + "/encounters/" + eid + "/participants"
      ).then((r) => r.json());
      for (const x of p.friendlies || []) {
        if (x.characterType !== "player" || x.isPet) continue;
        let cur = roster.get(x.id);
        if (!cur) {
          cur = { id: x.id, name: x.name, specCounts: {} };
          roster.set(x.id, cur);
        }
        if (x.spec) cur.specCounts[x.spec] = (cur.specCounts[x.spec] || 0) + 1;
      }
    } catch {
      /* skip an unreadable encounter */
    }
  });

  const players = [...roster.values()].map((c) => ({
    id: c.id,
    name: c.name,
    spec:
      Object.keys(c.specCounts).sort((a, b) => c.specCounts[b] - c.specCounts[a])[0] || "",
    role: null,
  }));

  // Successful boss kills define the throughput window (matches the site's
  // damage/healing tables); fall back to all boss pulls if there were no kills.
  let killEncs = encounters.filter((e) => e.is_boss_encounter && e.success);
  if (!killEncs.length) killEncs = encounters.filter((e) => e.is_boss_encounter);
  const killIds = killEncs.map((e) => e.id);
  const duration = killEncs.reduce((s, e) => s + parseFloat(e.duration_seconds || 0), 0);

  return {
    reportId: String(reportId),
    title: report.title || "",
    zone,
    difficulty: meta.reportDifficulty || report.difficulty || null,
    date: report.start_time || null,
    players,
    killIds,
    duration,
  };
}

// Per-character DPS/HPS across the kill window: sum each player's damage and
// effective healing, divide by total kill duration.
async function fetchThroughput(reportId, killIds, duration) {
  const out = {};
  if (!killIds.length || !duration) return out;
  const q = (metric) =>
    "/api/reports/" + reportId + "/" + metric +
    "?scope=encounter&encounterIds=" + killIds.join(",") +
    "&format=flat&limit=10000&participantType=friendlies";
  try {
    const [dmg, heal] = await Promise.all([
      logsFetch(q("character_spell_damage")).then((r) => r.json()),
      logsFetch(q("character_spell_healing")).then((r) => r.json()),
    ]);
    const add = (rows, field, key) => {
      for (const r of rows || []) {
        if (r.character_type !== "player") continue;
        const o = (out[r.character_id] = out[r.character_id] || { dmg: 0, heal: 0 });
        o[key] += Number(r[field]) || 0;
      }
    };
    add(dmg.rows, "total_damage", "dmg");
    add(heal.rows, "effective_healing", "heal");
    for (const id of Object.keys(out)) {
      out[id].dps = Math.round(out[id].dmg / duration);
      out[id].hps = Math.round(out[id].heal / duration);
    }
  } catch {
    /* throughput is best-effort */
  }
  return out;
}

// Import an entire raid: fetch each member's build, save it, and record the
// group with per-member role (tank / healer / dps from Darkmoon spec+role).
async function importRaidGroup(reportId, origin, bucket = "") {
  const raid = await fetchRaidRoster(reportId);
  if (!raid.players.length) throw new Error("No players found in this report.");
  const { catalog } = await loadBuilder();

  // Per-character throughput over the kill window: DPS from total damage,
  // HPS from effective healing, each divided by total kill duration.
  const throughput = await fetchThroughput(reportId, raid.killIds, raid.duration);

  const members = await mapLimit(raid.players, 6, async (pl) => {
    const role = roleFromSpec(pl.spec, pl.role);
    const tp = throughput[pl.id] || {};
    const base = {
      characterId: String(pl.id),
      name: pl.name,
      spec: pl.spec,
      role,
      dps: tp.dps || 0,
      hps: tp.hps || 0,
    };
    try {
      const char = await logsFetch("/api/armory/character/" + pl.id).then((r) => r.json());
      if (!char || !char.success) throw new Error("no capture");
      const parsed = parseCharacter(char);
      if (!parsed.abilities.length && !parsed.talents.length) throw new Error("empty build");
      const result = buildResult(parsed, catalog, { origin });
      const key = buildKey({ characterId: pl.id, name: pl.name, fingerprint: result.fingerprint });
      const capturedAt =
        (char.capture && char.capture.captured_at) ||
        (char.ci_resolved && char.ci_resolved.captured_at) ||
        null;
      // Raid members are NOT bucket-tagged and NOT "direct": they live only in
      // their raid group, not in the standalone Builds / bucket lists.
      await recordBuild({
        key,
        name: pl.name,
        direct: false,
        characterId: String(pl.id),
        fingerprint: result.fingerprint,
        capturedAt,
        primaryToken: result.primaryToken,
        abilityCount: result.abilityCount,
        talentCount: result.talentCount,
        abilities: parsed.abilityNames,
        talents: parsed.talentNames,
        flat: result.flat,
        payload: result.payload,
      });
      return { ...base, buildKey: key, saved: true, abilityCount: result.abilityCount, talentCount: result.talentCount };
    } catch {
      return { ...base, buildKey: null, saved: false };
    }
  });

  const order = { tank: 0, healer: 1, dps: 2 };
  members.sort((a, b) => (order[a.role] - order[b.role]) || a.name.localeCompare(b.name));

  return recordGroup({
    key: "report:" + raid.reportId,
    reportId: raid.reportId,
    zone: raid.zone,
    difficulty: raid.difficulty,
    date: raid.date,
    title: raid.title,
    bucket,
    members,
  });
}

// ---------------------------------------------------------------------------
// Security / infra helpers
// ---------------------------------------------------------------------------

function clientIp(req) {
  if (TRUST_PROXY) {
    // Behind Cloudflare's proxy this is the authoritative client IP and can't
    // be spoofed by the client; prefer it, then fall back to X-Forwarded-For.
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

const rlMap = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  let e = rlMap.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rlMap.set(ip, e);
  }
  e.count++;
  return e.count > RATE_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rlMap) if (now > v.resetAt) rlMap.delete(k);
}, RATE_WINDOW_MS).unref?.();

function constantEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
// Admin check: open when no ADMIN_TOKEN configured; otherwise require a match
// via the x-admin-token header (used by the /builds page) or a bearer token.
function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const header = req.headers["x-admin-token"];
  if (header && constantEquals(header, ADMIN_TOKEN)) return true;
  const auth = req.headers["authorization"] || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!(m && constantEquals(m[1], ADMIN_TOKEN));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(res, name) {
  const safe = basename(name); // strip any path components, defence in depth
  if (!STATIC_ALLOW.has(safe)) {
    res.writeHead(404, SECURITY_HEADERS).end("Not found");
    return;
  }
  try {
    const data = await readFile(join(__dirname, "public", "_abi", safe));
    res.writeHead(200, {
      "content-type": STATIC_TYPES[extname(safe)] || "application/octet-stream",
      "cache-control": "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(data);
  } catch {
    res.writeHead(404, SECURITY_HEADERS).end("Not found");
  }
}

// Reverse-proxy builder assets only (icons/atlas.webp, favicon). Anything that
// isn't an allowlisted asset path is refused, so this can't be abused as a
// general-purpose web proxy.
async function proxyAsset(req, res, pathname, search) {
  if (!ASSET_RE.test(pathname)) {
    res.writeHead(404, SECURITY_HEADERS).end("Not found");
    return;
  }
  try {
    const upstream = await fetch(BUILDER_ORIGIN + pathname + (search || ""), {
      headers: { Accept: req.headers.accept || "*/*" },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "cache-control": upstream.headers.get("cache-control") || "public, max-age=3600",
      ...SECURITY_HEADERS,
    });
    res.end(buf);
  } catch {
    res.writeHead(502, SECURITY_HEADERS).end("Upstream error");
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  try {
    if (pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    // Rate limit everything else.
    if (rateLimited(clientIp(req))) {
      res.writeHead(429, { "retry-after": "60", ...SECURITY_HEADERS });
      return res.end("Too many requests");
    }

    if (pathname === "/api/build" && req.method === "GET") {
      const target = parseTarget(url.searchParams.get("target"));

      // Whole-raid import: save every member's build + a group record.
      if (target.kind === "report") {
        const group = await importRaidGroup(
          target.value,
          url.origin || "",
          url.searchParams.get("bucket") || ""
        );
        return sendJson(res, 200, { ok: true, kind: "group", group });
      }

      const { char, name, id } = await fetchCharacter(target);
      const { catalog } = await loadBuilder();
      const parsed = parseCharacter(char);
      if (!parsed.abilities.length && !parsed.talents.length) {
        throw new Error("This build has no abilities or talents selected.");
      }
      const result = buildResult(parsed, catalog, { origin: url.origin || "" });
      result.characterName = name;

      // Key by character + build content: distinct builds (respecs) each get
      // their own entry; an identical re-import updates the existing one.
      const key = buildKey({
        characterId: id,
        name,
        fingerprint: result.fingerprint,
      });
      // When Darkmoon captured/parsed this build (vs. when we imported it).
      const capturedAt =
        (char.capture && char.capture.captured_at) ||
        (char.ci_resolved && char.ci_resolved.captured_at) ||
        null;
      try {
        await recordBuild({
          key,
          name,
          label: (url.searchParams.get("label") || "").trim(),
          bucket: url.searchParams.get("bucket") || "",
          direct: true,
          characterId: id ? String(id) : null,
          fingerprint: result.fingerprint,
          capturedAt,
          primaryToken: result.primaryToken,
          abilityCount: result.abilityCount,
          talentCount: result.talentCount,
          abilities: parsed.abilityNames,
          talents: parsed.talentNames,
          flat: result.flat,
          payload: result.payload,
        });
      } catch (e) {
        console.warn("Failed to record build:", e.message);
      }
      result.key = key;
      return sendJson(res, 200, { ok: true, kind: "build", result });
    }

    // ---- Roster: admin-gated when ADMIN_TOKEN is set ----
    if (pathname === "/api/builds" && req.method === "GET") {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: "admin token required" });
      return sendJson(res, 200, { ok: true, builds: await listBuilds() });
    }

    if (pathname === "/api/groups" && req.method === "GET") {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: "admin token required" });
      return sendJson(res, 200, { ok: true, groups: await listGroups() });
    }

    // Public single-build lookup by key, so "Open in planner" deep links work
    // for everyone (friends included), including raid-only member builds.
    if (pathname === "/api/saved" && req.method === "GET") {
      const b = await getBuild(url.searchParams.get("key") || "");
      if (!b) return sendJson(res, 404, { ok: false, error: "not found" });
      return sendJson(res, 200, {
        ok: true,
        build: { key: b.key, name: b.name, label: b.label, flat: b.flat, payload: b.payload },
      });
    }

    // Public, name-scoped view of a friend's bucket (no login — anyone with the
    // bucket name sees its builds; that's the intended low-friction model).
    if (pathname === "/api/bucket" && req.method === "GET") {
      const name = normBucket(url.searchParams.get("name"));
      if (!name) return sendJson(res, 400, { ok: false, error: "bucket name required" });
      const lc = name.toLowerCase();
      const inBucket = (r) =>
        Array.isArray(r.buckets) && r.buckets.some((b) => b.toLowerCase() === lc);
      const builds = (await listBuilds()).filter(inBucket);
      const groups = (await listGroups()).filter(inBucket);
      return sendJson(res, 200, { ok: true, bucket: name, builds, groups });
    }

    if (pathname === "/api/groups/label" && req.method === "POST") {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: "admin token required" });
      const body = await readBody(req);
      const g = await setGroupLabel(body.key, body.label);
      if (!g) throw new Error("Group not found.");
      return sendJson(res, 200, { ok: true, group: g });
    }

    if (pathname === "/api/groups/delete" && req.method === "POST") {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: "admin token required" });
      const body = await readBody(req);
      const removed = await deleteGroup(body.key);
      return sendJson(res, 200, { ok: true, removed });
    }

    if (pathname === "/api/builds/label" && req.method === "POST") {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: "admin token required" });
      const body = await readBody(req);
      const rec = await setLabel(body.key, body.label);
      if (!rec) throw new Error("Build not found.");
      return sendJson(res, 200, { ok: true, build: rec });
    }

    if (pathname === "/api/builds/delete" && req.method === "POST") {
      if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: "admin token required" });
      const body = await readBody(req);
      const removed = await deleteBuild(body.key);
      return sendJson(res, 200, { ok: true, removed });
    }

    if (pathname === "/builds") {
      // Page loads for everyone but its data calls are admin-gated; the page
      // asks for the token and stores it locally.
      return serveStatic(res, "builds.html");
    }

    if (pathname.startsWith("/_abi/")) {
      return serveStatic(res, pathname.slice("/_abi/".length));
    }

    if (pathname === "/" || pathname === "/index.html") {
      const { html } = await loadBuilder();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        ...SECURITY_HEADERS,
      });
      return res.end(html);
    }

    return proxyAsset(req, res, pathname, url.search);
  } catch (err) {
    if (pathname.startsWith("/api/")) {
      return sendJson(res, 400, { ok: false, error: err.message || String(err) });
    }
    res.writeHead(500, { "content-type": "text/plain", ...SECURITY_HEADERS });
    res.end("Error: " + (err.message || String(err)));
  }
});

server.listen(PORT, () => {
  console.log(`Ascension Build Importer web app listening on http://0.0.0.0:${PORT}`);
  console.log(
    ADMIN_TOKEN
      ? "Roster is admin-protected (ADMIN_TOKEN set)."
      : "Roster is OPEN (no ADMIN_TOKEN) — fine on a LAN, set one before exposing publicly."
  );
  loadBuilder().then(
    (b) => console.log(`Builder cached: ${b.catalog.count} spells (${b.catalog.season}).`),
    (e) => console.warn("Initial builder fetch failed:", e.message)
  );
});
