// Ascension Build Importer — self-hosted web app.
//
// Serves the ascension.nie.one builder with a "Fetch from Darkmoon log" widget
// injected, and exposes /api/build which does the Darkmoon lookup + conversion
// server-side (where the same-origin Referer the API requires is trivial to set,
// and cross-origin/CORS limits don't apply).
//
// Zero runtime dependencies — Node 18+ built-ins only (http, fetch, fs).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import {
  extractCatalog,
  parseCharacter,
  buildResult,
  parseTarget,
} from "./lib/convert.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const BUILDER_ORIGIN = process.env.BUILDER_ORIGIN || "https://ascension.nie.one";
const LOGS_ORIGIN =
  process.env.LOGS_ORIGIN || "https://darkmoon.ascensionlogs.gg";
// How long to cache the (large) builder page + catalog before refetching.
const BUILDER_TTL_MS = Number(process.env.BUILDER_TTL_MS || 6 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Builder page: fetch, inject our widget, cache alongside the parsed catalog.
// ---------------------------------------------------------------------------

let builderCache = null; // { html, catalog, fetchedAt }
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
  if (
    !force &&
    builderCache &&
    Date.now() - builderCache.fetchedAt < BUILDER_TTL_MS
  ) {
    return builderCache;
  }
  if (builderInflight) return builderInflight;

  builderInflight = (async () => {
    try {
      const res = await fetch(BUILDER_ORIGIN + "/", { cache: "no-cache" });
      if (!res.ok) throw new Error("Builder returned HTTP " + res.status);
      const raw = await res.text();
      const catalog = extractCatalog(raw);
      builderCache = {
        html: injectWidget(raw),
        catalog,
        fetchedAt: Date.now(),
      };
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
    return { char, name: byName.character.name };
  }
  // id path (works for hidden armories reachable via reports)
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
  return { char, name };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const STATIC_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function serveStatic(res, name) {
  try {
    const file = join(__dirname, "public", "_abi", name);
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": STATIC_TYPES[extname(name)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// Reverse-proxy anything we don't handle (icons/atlas.webp, favicon, etc.) to
// the real builder origin, so its assets keep working from our origin.
async function proxyAsset(req, res, pathname, search) {
  try {
    const upstream = await fetch(BUILDER_ORIGIN + pathname + (search || ""), {
      headers: { Accept: req.headers.accept || "*/*" },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const headers = { "content-type": upstream.headers.get("content-type") || "application/octet-stream" };
    const cc = upstream.headers.get("cache-control");
    if (cc) headers["cache-control"] = cc;
    res.writeHead(upstream.status, headers);
    res.end(buf);
  } catch {
    res.writeHead(502).end("Upstream error");
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

    if (pathname === "/api/build") {
      const target = parseTarget(url.searchParams.get("target"));
      const { char, name } = await fetchCharacter(target);
      const { catalog } = await loadBuilder();
      const parsed = parseCharacter(char);
      if (!parsed.abilities.length && !parsed.talents.length) {
        throw new Error("This build has no abilities or talents selected.");
      }
      const result = buildResult(parsed, catalog, {
        origin: url.origin || "",
      });
      result.characterName = name;
      return sendJson(res, 200, { ok: true, result });
    }

    if (pathname.startsWith("/_abi/")) {
      return serveStatic(res, pathname.slice("/_abi/".length));
    }

    if (pathname === "/" || pathname === "/index.html") {
      const { html } = await loadBuilder();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      });
      return res.end(html);
    }

    // Everything else: proxy to the real builder for its assets.
    return proxyAsset(req, res, pathname, url.search);
  } catch (err) {
    if (pathname === "/api/build") {
      return sendJson(res, 400, { ok: false, error: err.message || String(err) });
    }
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Error: " + (err.message || String(err)));
  }
});

server.listen(PORT, () => {
  console.log(
    `Ascension Build Importer web app listening on http://0.0.0.0:${PORT}`
  );
  // Warm the cache so the first visitor doesn't wait on the upstream fetch.
  loadBuilder().then(
    (b) => console.log(`Builder cached: ${b.catalog.count} spells (${b.catalog.season}).`),
    (e) => console.warn("Initial builder fetch failed:", e.message)
  );
});
