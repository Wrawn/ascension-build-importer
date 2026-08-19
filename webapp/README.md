# Ascension Build Importer — self-hosted web app

A self-hosted mirror of the [ascension.nie.one](https://ascension.nie.one)
build planner with a **"⚒ Import from Darkmoon log"** box built in. Paste a
character name, id, armory URL, or a report link (`…?source=6046`) and it loads
that player's abilities + talents + primary stat straight into the planner as an
**editable build** — no manual transcribing, no browser extension.

Runs as a single small Docker container. Ideal for an Unraid box.

## How it works

- The container serves the real builder page (fetched live from
  ascension.nie.one and cached), with a small widget injected before `</body>`.
- Builder assets it needs (the `/icons/atlas.webp` sprite, favicon) are
  reverse-proxied through the container, so everything is same-origin.
- `GET /api/build?target=…` does the Darkmoon lookup **server-side**, where the
  same-origin `Referer` the Darkmoon API requires is trivial to set and browser
  CORS limits don't apply. It parses the capture, maps each `entry_id` to the
  builder's `spell_id` using the catalog embedded in the builder page, and
  returns the import string.
- The widget feeds that string to the builder's own **Import IDs** handler, which
  creates a normal editable, locally-saved build.

Because the builder page **and** the conversion catalog both come from the live
upstream (cached, default 6h), the app tracks the builder's seasonal updates
automatically — nothing to regenerate.

Zero runtime dependencies: Node 18+ built-ins only.

## Run it

### From the prebuilt image (recommended — GHCR)

CI publishes `ghcr.io/wrawn/ascension-build-importer:latest` on every push, so
you don't build anything on your server and Unraid's **Update** button works.

```bash
docker run -d --name ascension-build-importer --restart unless-stopped \
  -p 8787:8787 \
  -v /mnt/user/appdata/ascension-build-importer/data:/data \
  ghcr.io/wrawn/ascension-build-importer:latest
```

Then open `http://<your-server-ip>:8787/`.

> First time only: make the GHCR package **public** so the pull needs no login —
> GitHub → your **Packages** → `ascension-build-importer` → *Package settings* →
> *Change visibility* → **Public**. (Or `docker login ghcr.io` on the host.)

**Updating:** right-click the container in Unraid's **Docker** tab → *Check for
Updates* → *Force Update*. Your saved builds are untouched — they live in the
mounted `/data` volume, not the image.

### Docker Compose (builds locally from source)

```bash
cd webapp
docker compose up -d --build      # uses docker-compose.yml (image + volume)
```

### Locally without Docker

```bash
cd webapp
DATA_DIR=./data node server.js    # http://localhost:8787
```

## Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port the app listens on |
| `DATA_DIR` | `/data` (image) | Where saved builds are persisted — mount a volume here |
| `BUILDER_TTL_MS` | `21600000` (6h) | How long to cache the builder page + catalog |
| `BUILDER_ORIGIN` | `https://ascension.nie.one` | Upstream builder |
| `LOGS_ORIGIN` | `https://darkmoon.ascensionlogs.gg` | Upstream logs API |

## Saved builds (server-side)

**Every import through this instance is saved on the server** — so if your
friends import their builds via your URL, you get a roster of all of them.

- Browse them at **`/builds`** (also linked from the import widget).
- Each entry shows the character, ability/talent names, primary stat, and how
  many times it's been imported. You can **rename** it (give it a friendly name),
  **Copy IDs**, open a read-only **Preview link**, **Open in planner** (loads it
  as an editable build), or **Delete** it.
- The importer can also set a name at import time via the widget's *Save as…*
  field.

Data is a single JSON file at `$DATA_DIR/builds.json`. Mount `/data` to a host
path (as in the run command above) so it survives image updates. To back it up,
just copy that file. Individual browser-saved builds (the planner's own
localStorage) still work too and are independent of this.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /` | Builder page with the import widget injected |
| `GET /api/build?target=<name\|id\|url>&label=<optional>` | Resolve + convert a Darkmoon build → import IDs, and record it (JSON) |
| `GET /builds` | Human-friendly page listing every saved build |
| `GET /api/builds` | All saved builds (JSON) |
| `POST /api/builds/label` | Rename a saved build — `{ key, label }` |
| `POST /api/builds/delete` | Delete a saved build — `{ key }` |
| `GET /_abi/*` | The injected widget + saved-builds page assets |
| `GET /healthz` | Liveness check (used by the Docker healthcheck) |
| `GET /*` | Reverse-proxy to the upstream builder for its assets |

## A note on courtesy

This mirrors a community fan tool (ascension.nie.one) for your own/guild use.
It always pulls the current upstream page rather than shipping a frozen copy, so
the original author's work stays intact and up to date. Keep it to personal /
community use.
