// Injected into the builder page. Adds a "Fetch from Darkmoon log" panel that
// calls our /api/build endpoint and loads the result into the builder using its
// own Import IDs handler (which produces an editable, locally-saved build).

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const kid of kids) node.append(kid);
    return node;
  }

  function setStatus(node, text, kind) {
    node.textContent = text || "";
    node.className = "abi-status" + (kind ? " abi-" + kind : "");
  }

  // Load a flat decimal ID string via the builder's own Import IDs button.
  // We run in the page's context, so overriding prompt is visible to its handler.
  function importFlat(flat) {
    const btn = document.getElementById("import-build");
    if (!btn) throw new Error("Builder import button not found (page still loading?).");
    const original = window.prompt;
    window.prompt = () => flat;
    try {
      btn.click();
    } finally {
      window.prompt = original;
    }
  }

  async function fetchBuild(target) {
    const res = await fetch("/api/build?target=" + encodeURIComponent(target));
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response." }));
    if (!res.ok || !data.ok) {
      throw new Error(data && data.error ? data.error : "Request failed.");
    }
    return data.result;
  }

  function build() {
    const input = el("input", {
      type: "text",
      class: "abi-input",
      placeholder: "Name, id, or a Darkmoon armory / report URL",
    });
    const status = el("div", { class: "abi-status" });
    const goBtn = el("button", { class: "abi-go", type: "button" }, "Fetch build");

    async function run() {
      const target = input.value.trim();
      if (!target) {
        setStatus(status, "Enter a character name or Darkmoon link.", "error");
        return;
      }
      goBtn.disabled = true;
      setStatus(status, "Fetching …");
      try {
        const r = await fetchBuild(target);
        importFlat(r.flat);
        let msg =
          "Loaded " + r.characterName + ": " +
          r.abilityCount + " abilities, " + r.talentCount + " talents.";
        if (r.unknown && r.unknown.length) {
          msg += " " + r.unknown.length + " skipped (not in catalog).";
        }
        setStatus(status, msg, "ok");
      } catch (err) {
        setStatus(status, err.message || "Something went wrong.", "error");
      } finally {
        goBtn.disabled = false;
      }
    }

    goBtn.addEventListener("click", run);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });

    const panel = el(
      "div",
      { class: "abi-panel", id: "abi-panel" },
      el(
        "div",
        { class: "abi-head" },
        el("span", { class: "abi-title" }, "⚒ Import from Darkmoon log"),
        el("button", { class: "abi-close", type: "button", title: "Hide" }, "–")
      ),
      el("div", { class: "abi-row" }, input, goBtn),
      status,
      el(
        "div",
        { class: "abi-hint" },
        "Paste an armory page, a report link (…?source=id), or just a name. Loads as an editable build."
      )
    );

    const fab = el(
      "button",
      { class: "abi-fab", id: "abi-fab", type: "button", title: "Import from Darkmoon log" },
      "⚒"
    );

    function show(open) {
      panel.classList.toggle("abi-open", open);
      fab.classList.toggle("abi-hidden", open);
      if (open) input.focus();
    }
    $(".abi-close", panel).addEventListener("click", () => show(false));
    fab.addEventListener("click", () => show(true));

    document.body.append(panel, fab);
    show(true); // start open so the feature is discoverable
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
