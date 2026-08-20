// Ascension Build Importer — service worker
//
// Responsibilities:
//   1. Maintain a cached `entry_id -> spell_id` catalog scraped from the live
//      builder page (ascension.nie.one). The builder embeds every ability and
//      talent as `const spells = [...]`, each record carrying both the log-side
//      `entry_id` and the builder-side `spell_id`. We only need that mapping.
//   2. Turn a Darkmoon Logs character capture into the builder's compact share
//      link (`1.<season>.<primary>~<abilities>~<talents>`) and open it.
//
// Two entry points converge here:
//   - the "Open in Ascension Builder" button injected on armory pages
//     (content-darkmoon.js sends us the already-fetched character JSON), and
//   - the popup, which sends just a character name; we fetch it ourselves. A
//     declarativeNetRequest rule adds the same-origin Referer the API requires.

const BUILDER_ORIGIN = "https://ascension.nie.one";
const LOGS_ORIGIN = "https://darkmoon.ascensionlogs.gg";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once a day
const CATALOG_KEY = "catalog";

// Primary-stat spell IDs are stable game constants in the builder's PRIMARY_STATS
// table. Keyed by the token Darkmoon reports in `ci_resolved.primary_stat.token`.
const PRIMARY_STAT_SPELL_ID = {
  strength: 84864,
  agility: 84865,
  intellect: 84866,
  spirit: 84867,
  duality: 129243,
};

// ---------------------------------------------------------------------------
// Catalog: scrape + cache
// ---------------------------------------------------------------------------

// Scan a `[ ... ]` array literal that starts at `startBracket`, respecting
// string contents, and return the index just past the matching `]`. Using a
// naive indexOf(']') would break on descriptions that contain a bracket.
function findArrayEnd(text, startBracket) {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = startBracket; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++; // skip escaped char
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("Could not find the end of the catalog array.");
}

function extractCatalogFromHtml(html) {
  const marker = "const spells=";
  const at = html.indexOf(marker);
  if (at < 0) throw new Error("Builder catalog (const spells) not found.");
  const bracket = html.indexOf("[", at);
  if (bracket < 0) throw new Error("Builder catalog array not found.");
  const end = findArrayEnd(html, bracket);
  const spells = JSON.parse(html.slice(bracket, end));

  const entryToSpell = {};
  for (const s of spells) {
    if (s && s.entry_id != null && s.spell_id != null) {
      entryToSpell[s.entry_id] = s.spell_id;
    }
  }

  // Season token, e.g. "s10w60", lives in the compact-link template literal.
  const seasonMatch = html.match(/\bs(\d+)w(\d+)\b/);
  const season = seasonMatch ? seasonMatch[0] : "s10w60";

  return { entryToSpell, season, count: Object.keys(entryToSpell).length };
}

async function fetchCatalog() {
  const res = await fetch(BUILDER_ORIGIN + "/", { cache: "no-cache" });
  if (!res.ok) throw new Error("Builder returned HTTP " + res.status);
  const html = await res.text();
  const catalog = extractCatalogFromHtml(html);
  if (!catalog.count) throw new Error("Builder catalog was empty.");
  catalog.fetchedAt = Date.now();
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  return catalog;
}

async function getCatalog({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const stored = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY];
    if (stored && Date.now() - stored.fetchedAt < CATALOG_TTL_MS) return stored;
  }
  try {
    return await fetchCatalog();
  } catch (err) {
    // Fall back to a stale cache if we have one — better than failing outright.
    const stored = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY];
    if (stored) return stored;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Darkmoon capture -> entry ids
// ---------------------------------------------------------------------------

// Pull the selected ability/talent entry ids and primary-stat token out of a
// `/api/armory/character/{id}` payload. Prefer the authoritative tree split;
// fall back to classifying the flat hero_build list via the catalog.
function parseCharacter(charJson, catalog) {
  const spec =
    charJson &&
    charJson.ci_resolved &&
    charJson.ci_resolved.specialization;
  if (!spec) throw new Error("This capture has no talent data.");

  let abilities = [];
  let talents = [];

  const trees = spec.talents && spec.talents.trees;
  if (trees && trees.abilities && trees.talents) {
    abilities = (trees.abilities.talents || []).map((t) => t.entry_id);
    talents = (trees.talents.talents || []).map((t) => t.entry_id);
  } else if (spec.hero_build) {
    // Fallback: hero_build is slot -> { rank, entry_id }. Classify by catalog
    // membership isn't enough (we only cached spell ids), so treat everything
    // as abilities unless we can tell otherwise. The tree split above is the
    // normal path; this only guards against unusual schemas.
    for (const key of Object.keys(spec.hero_build)) {
      const eid = spec.hero_build[key] && spec.hero_build[key].entry_id;
      if (eid != null) abilities.push(eid);
    }
  } else {
    throw new Error("This capture has no talent data.");
  }

  const primaryToken =
    charJson.ci_resolved.primary_stat &&
    charJson.ci_resolved.primary_stat.token;

  return { abilities, talents, primaryToken };
}

// ---------------------------------------------------------------------------
// entry ids -> compact builder link
// ---------------------------------------------------------------------------

function toBase36Side(spellIds) {
  return spellIds.map((id) => Number(id).toString(36)).join(".");
}

function buildCompactLink(parsed, catalog) {
  const map = catalog.entryToSpell;
  const unknown = [];

  const mapSide = (entryIds) => {
    const out = [];
    for (const eid of entryIds) {
      const sid = map[eid];
      if (sid == null) unknown.push(eid);
      else out.push(sid);
    }
    return out;
  };

  const abilitySpells = mapSide(parsed.abilities);
  const talentSpells = mapSide(parsed.talents);

  const primarySpell = parsed.primaryToken
    ? PRIMARY_STAT_SPELL_ID[parsed.primaryToken]
    : null;
  const primaryPart = primarySpell != null ? primarySpell.toString(36) : "";

  const payload =
    "1." +
    catalog.season +
    "." +
    primaryPart +
    "~" +
    toBase36Side(abilitySpells) +
    "~" +
    toBase36Side(talentSpells);

  return {
    url: BUILDER_ORIGIN + "/#b=" + payload,
    abilityCount: abilitySpells.length,
    talentCount: talentSpells.length,
    primaryToken: parsed.primaryToken || null,
    unknown,
  };
}

// ---------------------------------------------------------------------------
// High-level flows
// ---------------------------------------------------------------------------

async function convertPayload(charJson) {
  const catalog = await getCatalog();
  const parsed = parseCharacter(charJson, catalog);
  if (!parsed.abilities.length && !parsed.talents.length) {
    throw new Error("This build has no abilities or talents selected.");
  }
  return buildCompactLink(parsed, catalog);
}

async function fetchCharacterByName(name) {
  const clean = encodeURIComponent(String(name).trim());
  const byName = await fetch(
    LOGS_ORIGIN + "/api/armory/by-name/" + clean
  ).then((r) => r.json());
  if (!byName || !byName.success || !byName.character) {
    throw new Error('Character "' + name + '" was not found on Darkmoon Logs.');
  }
  if (!byName.has_armory) {
    throw new Error('"' + byName.character.name + '" has no armory capture yet.');
  }
  const id = byName.character.id;
  const char = await fetch(
    LOGS_ORIGIN + "/api/armory/character/" + id
  ).then((r) => r.json());
  if (!char || !char.success) {
    throw new Error("Could not load the armory capture.");
  }
  return { char, name: byName.character.name };
}

async function fetchCharacterById(id) {
  const clean = encodeURIComponent(String(id).trim());
  const char = await fetch(
    LOGS_ORIGIN + "/api/armory/character/" + clean
  ).then((r) => r.json());
  if (!char || !char.success) {
    throw new Error("No build capture available for character #" + id + ".");
  }
  const name =
    (char.ci_resolved && char.ci_resolved.player) ||
    (char.character && char.character.name) ||
    ("#" + id);
  return { char, name };
}

async function openBuild(result) {
  await chrome.tabs.create({ url: result.url });
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "convertPayload") {
        // From the armory-page button: it already fetched the character JSON.
        const result = await convertPayload(msg.payload);
        if (msg.open !== false) await openBuild(result);
        sendResponse({ ok: true, result });
      } else if (msg.type === "convertByName") {
        // From the popup: we fetch the character ourselves.
        const { char, name } = await fetchCharacterByName(msg.name);
        const result = await convertPayload(char);
        result.characterName = name;
        if (msg.open !== false) await openBuild(result);
        sendResponse({ ok: true, result });
      } else if (msg.type === "convertById") {
        // From the popup, given a report URL's numeric source id.
        const { char, name } = await fetchCharacterById(msg.id);
        const result = await convertPayload(char);
        result.characterName = name;
        if (msg.open !== false) await openBuild(result);
        sendResponse({ ok: true, result });
      } else if (msg.type === "refreshCatalog") {
        const catalog = await getCatalog({ forceRefresh: true });
        sendResponse({
          ok: true,
          count: catalog.count,
          season: catalog.season,
          fetchedAt: catalog.fetchedAt,
        });
      } else if (msg.type === "catalogStatus") {
        const stored = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY];
        sendResponse({ ok: true, catalog: stored || null });
      } else if (msg.type === "openImport") {
        // Send a Darkmoon link to the user's self-hosted webapp, which fetches,
        // converts, saves it to their roster, and loads it in their planner.
        const base = String(msg.webappUrl || "").replace(/\/+$/, "");
        if (!base) throw new Error("No builder URL configured.");
        const url = base + "/#import=" + encodeURIComponent(msg.target);
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown request." });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
