// Injected into the builder page. Adds a "Fetch from Darkmoon log" panel that
// calls our /api/build endpoint and loads the result into the builder using its
// own Import IDs handler (which produces an editable, locally-saved build).
// Every fetch is also persisted server-side; see the "Saved builds" link.

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

  async function fetchBuild(target, label, bucket) {
    let u = "/api/build?target=" + encodeURIComponent(target);
    if (label) u += "&label=" + encodeURIComponent(label);
    if (bucket) u += "&bucket=" + encodeURIComponent(bucket);
    const res = await fetch(u);
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response." }));
    if (!res.ok || !data.ok) {
      throw new Error(data && data.error ? data.error : "Request failed.");
    }
    return data; // { kind: "build"|"group", result? , group? }
  }

  // Load a previously-saved build (by key) into the planner via the public
  // single-build endpoint, so it works for friends and admins alike.
  async function loadSaved(key) {
    const res = await fetch("/api/saved?key=" + encodeURIComponent(key));
    if (res.status === 404) throw new Error("Saved build not found.");
    const data = await res.json().catch(() => ({}));
    if (!data.ok || !data.build) throw new Error("Could not load saved build.");
    importFlat(data.build.flat);
    return data.build;
  }

  function build() {
    const input = el("input", {
      type: "text",
      class: "abi-input",
      placeholder: "Name, id, or a Darkmoon armory / report URL",
    });
    const labelInput = el("input", {
      type: "text",
      class: "abi-input abi-label",
      placeholder: "Save as… (optional name)",
    });
    const bucketInput = el("input", {
      type: "text",
      class: "abi-input abi-label",
      placeholder: "Your bucket (e.g. your name)",
    });
    bucketInput.value = localStorage.getItem("abi-bucket") || "";
    bucketInput.addEventListener("change", () =>
      localStorage.setItem("abi-bucket", bucketInput.value.trim())
    );
    const status = el("div", { class: "abi-status" });
    const goBtn = el("button", { class: "abi-go", type: "button" }, "Fetch build");

    async function run() {
      const target = input.value.trim();
      if (!target) {
        setStatus(status, "Enter a character name or Darkmoon link.", "error");
        return;
      }
      goBtn.disabled = true;
      const bucket = bucketInput.value.trim();
      if (bucket) localStorage.setItem("abi-bucket", bucket);
      const isReport = /\/reports\/\d+/.test(target) && !/[?&]source=\d+/.test(target);
      setStatus(status, isReport ? "Importing raid — this can take a few seconds …" : "Fetching …");
      try {
        const data = await fetchBuild(target, labelInput.value.trim(), bucket);
        if (data.kind === "group") {
          const g = data.group;
          const saved = (g.members || []).filter((m) => m.saved).length;
          const t = (g.members || []).filter((m) => m.role === "tank").length;
          const h = (g.members || []).filter((m) => m.role === "healer").length;
          const d = (g.members || []).filter((m) => m.role === "dps").length;
          setStatus(
            status,
            "Saved raid " + (g.zone || "group") + ": " + saved + " builds " +
              "(" + t + " tank, " + h + " healer, " + d + " dps). See Saved builds →",
            "ok"
          );
          return;
        }
        const r = data.result;
        importFlat(r.flat);
        let msg =
          "Loaded " + r.characterName + ": " +
          r.abilityCount + " abilities, " + r.talentCount + " talents. Saved ✓";
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
    for (const box of [input, labelInput, bucketInput]) {
      box.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    }

    const savedLink = el(
      "a",
      { class: "abi-saved", href: "/builds", target: "_blank", rel: "noopener" },
      "📋 Saved builds"
    );

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
      labelInput,
      bucketInput,
      status,
      el(
        "div",
        { class: "abi-foot" },
        el(
          "span",
          { class: "abi-hint" },
          "Armory page, report link (…?source=id), or a name. Loads editable & saves to the server."
        ),
        savedLink
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

    // Deep links:
    //   #saved=<key>     load a saved build into the planner
    //   #import=<target> import a Darkmoon link/name (the browser extension uses
    //                    this to send a build straight to this instance)
    async function handleHash() {
      const saved = location.hash.match(/^#saved=(.+)$/);
      if (saved) {
        const key = decodeURIComponent(saved[1]);
        history.replaceState(null, "", location.pathname + "#builder");
        show(true);
        setStatus(status, "Loading saved build …");
        try {
          const rec = await loadSaved(key);
          setStatus(status, "Loaded saved build: " + (rec.label || rec.name) + ".", "ok");
        } catch (err) {
          setStatus(status, err.message || "Could not load saved build.", "error");
        }
        return;
      }
      const imp = location.hash.match(/^#import=(.+)$/);
      if (imp) {
        const target = decodeURIComponent(imp[1]);
        history.replaceState(null, "", location.pathname + "#builder");
        show(true);
        input.value = target;
        run(); // fetch + save server-side, then load into the planner
      }
    }
    window.addEventListener("hashchange", handleHash);
    handleHash();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
