// Ascension Build Importer — popup

const nameInput = document.getElementById("name");
const goBtn = document.getElementById("go");
const statusEl = document.getElementById("status");
const catalogInfo = document.getElementById("catalog-info");
const refreshLink = document.getElementById("refresh");

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

// Accept a bare name, an armory URL, or a report URL with ?source=<id>.
// Returns { kind: "id"|"name", value, label }.
function parseInput(raw) {
  const value = raw.trim();
  if (!value) return null;

  // Report URL (or any URL) carrying a numeric source id.
  const sourceMatch = value.match(/[?&]source=(\d+)/i);
  if (sourceMatch) return { kind: "id", value: sourceMatch[1], label: "#" + sourceMatch[1] };

  // Armory URL -> name.
  const armoryMatch = value.match(/armory\/([^/?#]+)/i);
  if (armoryMatch) {
    const name = decodeURIComponent(armoryMatch[1]);
    return { kind: "name", value: name, label: name };
  }

  // A bare number is treated as a character id.
  if (/^\d+$/.test(value)) return { kind: "id", value, label: "#" + value };

  return { kind: "name", value, label: value };
}

async function submit() {
  const target = parseInput(nameInput.value);
  if (!target) {
    setStatus("Enter a character name, id, or armory/report URL.", "error");
    return;
  }
  goBtn.disabled = true;
  setStatus("Fetching " + target.label + "…");
  try {
    const resp = await chrome.runtime.sendMessage(
      target.kind === "id"
        ? { type: "convertById", id: target.value }
        : { type: "convertByName", name: target.value }
    );
    if (!resp || !resp.ok) {
      throw new Error(resp && resp.error ? resp.error : "Failed.");
    }
    const r = resp.result;
    let msg =
      "Opened: " + r.abilityCount + " abilities, " + r.talentCount + " talents.";
    if (r.unknown && r.unknown.length) {
      msg += " (" + r.unknown.length + " skipped)";
    }
    setStatus(msg, "ok");
    setTimeout(() => window.close(), 900);
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  } finally {
    goBtn.disabled = false;
  }
}

function renderCatalog(catalog) {
  if (!catalog) {
    catalogInfo.textContent = "Catalog: not loaded yet";
    return;
  }
  const when = new Date(catalog.fetchedAt);
  catalogInfo.textContent =
    "Catalog: " +
    catalog.count +
    " spells · " +
    catalog.season +
    " · " +
    when.toLocaleDateString();
}

async function loadCatalogStatus() {
  const resp = await chrome.runtime.sendMessage({ type: "catalogStatus" });
  if (resp && resp.ok) renderCatalog(resp.catalog);
}

goBtn.addEventListener("click", submit);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submit();
});
refreshLink.addEventListener("click", async () => {
  catalogInfo.textContent = "Catalog: refreshing…";
  const resp = await chrome.runtime.sendMessage({ type: "refreshCatalog" });
  if (resp && resp.ok) {
    renderCatalog({
      count: resp.count,
      season: resp.season,
      fetchedAt: resp.fetchedAt,
    });
  } else {
    catalogInfo.textContent = "Catalog: refresh failed";
  }
});

loadCatalogStatus();
