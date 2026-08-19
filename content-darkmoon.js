// Ascension Build Importer — Darkmoon Logs content script
//
// Adds an "Open in Ascension Builder" button to pages where a character's build
// is identifiable:
//   - armory pages:  /armory/<Name>            -> resolve by name
//   - report pages:  /reports/<id>/...?source=<charId>  -> use the id directly
//
// The id-based path matters because a character can hide their public armory
// profile while their captures stay visible inside reports; hitting the capture
// endpoint by numeric id sidesteps the hidden profile.
//
// All fetches run in the page (same origin), so the Referer the API requires is
// set automatically. The JSON is handed to the service worker, which converts it
// to a builder link and opens it.

(() => {
  const BTN_ID = "abi-open-builder-btn";

  // Return what character this page points at, or null.
  function getTarget() {
    const armory = location.pathname.match(/^\/armory\/([^/]+)/);
    if (armory) return { kind: "name", value: decodeURIComponent(armory[1]) };

    if (/^\/reports\//.test(location.pathname)) {
      const src = new URLSearchParams(location.search).get("source");
      if (src) {
        const first = src.split(",")[0].trim(); // one player at a time
        if (/^\d+$/.test(first)) return { kind: "id", value: first };
      }
    }
    return null;
  }

  function toast(message, isError) {
    let el = document.getElementById("abi-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "abi-toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = "abi-toast" + (isError ? " abi-toast-error" : "");
    el.classList.add("abi-show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("abi-show"), 4200);
  }

  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.classList.toggle("abi-busy", busy);
    btn.querySelector(".abi-label").textContent = busy
      ? "Building…"
      : "Open in Ascension Builder";
  }

  // Fetch the character capture JSON for the current target.
  async function fetchCapture(target) {
    if (target.kind === "name") {
      const byName = await fetch(
        "/api/armory/by-name/" + encodeURIComponent(target.value)
      ).then((r) => r.json());
      if (!byName || !byName.success || !byName.character) {
        throw new Error("Character not found.");
      }
      if (!byName.has_armory) {
        throw new Error("No armory capture for this character yet.");
      }
      return fetch("/api/armory/character/" + byName.character.id).then((r) =>
        r.json()
      );
    }
    // id path (reports)
    const char = await fetch(
      "/api/armory/character/" + encodeURIComponent(target.value)
    ).then((r) => r.json());
    if (!char || !char.success) {
      throw new Error("No build capture available for this player.");
    }
    return char;
  }

  async function onClick(btn) {
    const target = getTarget();
    if (!target) return;
    setBusy(btn, true);
    try {
      const char = await fetchCapture(target);
      const resp = await chrome.runtime.sendMessage({
        type: "convertPayload",
        payload: char,
      });
      if (!resp || !resp.ok) {
        throw new Error(resp && resp.error ? resp.error : "Conversion failed.");
      }
      const r = resp.result;
      let msg =
        "Opened builder: " +
        r.abilityCount +
        " abilities, " +
        r.talentCount +
        " talents.";
      if (r.unknown && r.unknown.length) {
        msg +=
          " " +
          r.unknown.length +
          " entr" +
          (r.unknown.length === 1 ? "y" : "ies") +
          " not in the current catalog were skipped.";
      }
      toast(msg, false);
    } catch (err) {
      toast(err.message || "Something went wrong.", true);
    } finally {
      setBusy(btn, false);
    }
  }

  function ensureButton() {
    const target = getTarget();
    const existing = document.getElementById(BTN_ID);
    if (!target) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.innerHTML =
      '<span class="abi-hammer" aria-hidden="true">⚒</span>' +
      '<span class="abi-label">Open in Ascension Builder</span>';
    btn.addEventListener("click", () => onClick(btn));
    document.body.appendChild(btn);
  }

  // React to SPA navigation (Darkmoon is a single-page app; report pages change
  // the ?source= query without a full reload).
  function hookHistory() {
    for (const fn of ["pushState", "replaceState"]) {
      const orig = history[fn];
      history[fn] = function () {
        const r = orig.apply(this, arguments);
        window.dispatchEvent(new Event("abi:locationchange"));
        return r;
      };
    }
    window.addEventListener("popstate", () =>
      window.dispatchEvent(new Event("abi:locationchange"))
    );
  }

  hookHistory();
  window.addEventListener("abi:locationchange", () =>
    setTimeout(ensureButton, 50)
  );
  // Safety net for navigations / query changes we might miss.
  setInterval(ensureButton, 1500);
  ensureButton();
})();
