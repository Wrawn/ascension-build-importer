// Shared conversion logic: Darkmoon capture -> builder import IDs.
//
// This is the same mapping the browser extension used, ported to run on the
// server. The builder's own catalog (`const spells = [...]`) carries both the
// log-side `entry_id` and the builder-side `spell_id`; we key on that.

export const PRIMARY_STAT_SPELL_ID = {
  strength: 84864,
  agility: 84865,
  intellect: 84866,
  spirit: 84867,
  duality: 129243,
};

// Scan a `[ ... ]` array literal starting at `startBracket`, respecting string
// contents, and return the index just past the matching `]`.
function findArrayEnd(text, startBracket) {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = startBracket; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === quote) inString = false;
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

// Extract { entryToSpell, season, count } from the builder page HTML.
export function extractCatalog(html) {
  const marker = "const spells=";
  const at = html.indexOf(marker);
  if (at < 0) throw new Error("Builder catalog (const spells) not found.");
  const bracket = html.indexOf("[", at);
  const end = findArrayEnd(html, bracket);
  const spells = JSON.parse(html.slice(bracket, end));

  const entryToSpell = new Map();
  for (const s of spells) {
    if (s && s.entry_id != null && s.spell_id != null) {
      entryToSpell.set(s.entry_id, s.spell_id);
    }
  }
  const seasonMatch = html.match(/\bs(\d+)w(\d+)\b/);
  const season = seasonMatch ? seasonMatch[0] : "s10w60";
  return { entryToSpell, season, count: entryToSpell.size };
}

// Pull selected ability/talent entry ids + primary token out of a
// /api/armory/character/{id} payload.
export function parseCharacter(charJson) {
  const spec = charJson?.ci_resolved?.specialization;
  if (!spec) throw new Error("This capture has no talent data.");

  let abilities = [];
  let talents = [];
  let abilityNames = [];
  let talentNames = [];
  const trees = spec.talents && spec.talents.trees;
  if (trees && trees.abilities && trees.talents) {
    const ab = trees.abilities.talents || [];
    const ta = trees.talents.talents || [];
    abilities = ab.map((t) => t.entry_id);
    talents = ta.map((t) => t.entry_id);
    abilityNames = ab.map((t) => t.name);
    talentNames = ta.map((t) => t.name);
  } else if (spec.hero_build) {
    for (const key of Object.keys(spec.hero_build)) {
      const eid = spec.hero_build[key] && spec.hero_build[key].entry_id;
      if (eid != null) abilities.push(eid);
    }
  } else {
    throw new Error("This capture has no talent data.");
  }

  const primaryToken = charJson.ci_resolved.primary_stat?.token || null;
  return { abilities, talents, abilityNames, talentNames, primaryToken };
}

// Build both import formats from parsed entry ids:
//   - flat:  "<primary>,<abilities...>,<talents...>"  (feeds the builder's
//            Import IDs box; classifies + sets primary stat, gives an editable
//            build)
//   - link:  "<origin>/#b=1.<season>.<primary36>~<ab36>~<ta36>"  (a shareable
//            read-only preview link)
export function buildResult(parsed, catalog, { origin = "" } = {}) {
  const map = catalog.entryToSpell;
  const unknown = [];
  const mapSide = (entryIds) => {
    const out = [];
    for (const eid of entryIds) {
      const sid = map.get(eid);
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

  const flatParts = [];
  if (primarySpell != null) flatParts.push(primarySpell);
  flatParts.push(...abilitySpells, ...talentSpells);
  const flat = flatParts.join(",");

  const b36 = (n) => Number(n).toString(36);
  const payload =
    "1." +
    catalog.season +
    "." +
    (primarySpell != null ? b36(primarySpell) : "") +
    "~" +
    abilitySpells.map(b36).join(".") +
    "~" +
    talentSpells.map(b36).join(".");

  return {
    flat,
    payload,
    link: origin + "/#b=" + payload,
    abilityCount: abilitySpells.length,
    talentCount: talentSpells.length,
    primaryToken: parsed.primaryToken,
    unknown,
  };
}

// Interpret a free-form target (name, id, armory URL, or report URL with
// ?source=id) into { kind: "id"|"name", value }.
export function parseTarget(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("Enter a character name, id, or Darkmoon link.");

  const sourceMatch = value.match(/[?&]source=(\d+)/i);
  if (sourceMatch) return { kind: "id", value: sourceMatch[1] };

  const armoryMatch = value.match(/armory\/([^/?#]+)/i);
  if (armoryMatch) return { kind: "name", value: decodeURIComponent(armoryMatch[1]) };

  if (/^\d+$/.test(value)) return { kind: "id", value };
  return { kind: "name", value };
}
