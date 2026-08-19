# Ascension Build Importer

Copy a character's **abilities and talents** from [Darkmoon Logs](https://darkmoon.ascensionlogs.gg)
straight into the [ascension.nie.one](https://ascension.nie.one/#builder) build
planner — so you don't have to transcribe them by hand.

**Two ways to run it:**

- **Browser extension** (this folder) — adds an "Open in Ascension Builder"
  button on Darkmoon pages; opens the build on the public planner. See below.
- **Self-hosted web app** ([`webapp/`](webapp/README.md)) — a single Docker
  container that serves the planner *with* an "Import from Darkmoon log" box
  built in, all on your own server (e.g. Unraid). Loads builds as editable, and
  needs no browser extension. **This is the recommended option for a home server.**

---

## Browser extension

A browser extension (Vivaldi / Chrome / any Chromium browser) that copies a
character's abilities and talents from Darkmoon Logs straight into the
ascension.nie.one build planner — so you don't have to transcribe them by hand.

## What it does

1. It adds an **"⚒ Open in Ascension Builder"** button (bottom-right) on any page
   that identifies a character:
   - **armory pages** — `.../armory/Imissyou`
   - **report pages** — `.../reports/449/encounters?source=6046` (with a player
     selected). This works even when the character's public armory profile is
     **hidden**, because the report resolves the build by numeric character id
     rather than the (hidden) name profile.
2. Click it — the extension reads that character's latest capture, converts the
   selected abilities/talents (and primary stat) into the builder's own share
   format, and opens the builder with the build loaded.
3. The build opens as a **read-only preview**. Click **"Save a copy"** in the
   builder to make it an editable build you can plan/roll from.

There's also a toolbar popup where you can paste a character name, a numeric
character id, an armory URL, or a report URL (`?source=…`) and jump straight to
that build without opening the page first.

## How it works (the short version)

- Darkmoon exposes each character at `/api/armory/character/{id}`. The selected
  abilities/talents live under `ci_resolved.specialization.talents.trees` as
  `entry_id`s.
- The builder page embeds its full catalog (`const spells = [...]`), where every
  entry has **both** the log-side `entry_id` **and** the builder-side `spell_id`.
  The extension scrapes that once and caches the `entry_id → spell_id` map.
- Builds are then encoded as the builder's compact link
  `1.<season>.<primary>~<abilities>~<talents>` (base-36 spell IDs) and opened
  directly — the same format the builder's own "Copy link" button produces.

Because the catalog and the season token (`s10w60`) are both read live from the
builder, the extension keeps working across catalog updates. The cache refreshes
automatically once a day, or manually via **"Refresh catalog"** in the popup.

## Install (Vivaldi)

1. Open `vivaldi://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder
   (the one containing `manifest.json`).
4. Visit a Darkmoon armory page and use the button, or click the toolbar icon.

The same steps work in Chrome/Edge/Brave via `chrome://extensions`.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, content-script + DNR wiring |
| `background.js` | Catalog scrape/cache, capture → compact-link conversion |
| `content-darkmoon.js` / `.css` | The on-page button on armory pages |
| `popup.html` / `popup.js` | Toolbar popup (search by name, catalog status) |
| `rules.json` | Adds the same-origin `Referer` the Darkmoon API requires |

## Permissions, and why

- `host_permissions` for `darkmoon.ascensionlogs.gg` and `ascension.nie.one` —
  to read captures and the builder catalog.
- `declarativeNetRequest` — the Darkmoon API rejects requests without a
  same-origin `Referer`; a single static rule adds it for the popup's lookups.
  (The on-page button doesn't need this — it fetches from the page itself.)
- `storage` — to cache the catalog map.

No data is sent anywhere except to those two sites, which you're already using.

## Known limitations

- Imports the character's **latest** capture. The Darkmoon API always returns the
  latest capture for a character (it ignores per-encounter/capture selection), so
  a report link imports that player's most recent build, not the specific pull —
  the same thing the site's own report build panel shows.
- Gear, enchants, and gems are not imported — the builder plans abilities and
  talents, so that's what's transferred.
- Opens as a read-only preview; use the builder's "Save a copy" to edit.
