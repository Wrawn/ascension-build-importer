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

### Docker Compose (recommended)

```bash
cd webapp
docker compose up -d --build
```

Then open `http://<your-server-ip>:8787/`.

### Plain Docker

```bash
cd webapp
docker build -t ascension-build-importer .
docker run -d --name ascension-build-importer -p 8787:8787 --restart unless-stopped ascension-build-importer
```

### On Unraid

The image needs a build step, so the easiest paths are:

1. **Compose Manager plugin** (Community Applications) → add a new stack →
   point it at this `webapp/` folder's `docker-compose.yml` → *Compose Up*. Or
2. Build once from a terminal (`docker build -t ascension-build-importer .` in
   this folder), then **Docker tab → Add Container**:
   - Repository: `ascension-build-importer:latest`
   - Network: `bridge`
   - Port: host `8787` → container `8787`
   - (optional) Env `BUILDER_TTL_MS`, `PORT`

No volumes or database are required — the app is stateless (see *Where builds
live* below).

### Locally without Docker

```bash
cd webapp
node server.js        # http://localhost:8787
```

## Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port the app listens on |
| `BUILDER_TTL_MS` | `21600000` (6h) | How long to cache the builder page + catalog |
| `BUILDER_ORIGIN` | `https://ascension.nie.one` | Upstream builder |
| `LOGS_ORIGIN` | `https://darkmoon.ascensionlogs.gg` | Upstream logs API |

## Where builds live (and the "don't lose them" concern)

Builds you save in the planner are stored in your **browser's localStorage**,
keyed to this app's origin (e.g. `http://your-unraid:8787`). Because you now own
the deployment, they won't vanish if the public site changes — but they're still
tied to the browser you use. Use the planner's own **Copy IDs** / **Copy link**
to export any single build as a portable string.

> Roadmap idea: an optional server-side "save named builds" store (survives
> browser resets, shareable across devices). Not built yet — say the word.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /` | Builder page with the import widget injected |
| `GET /api/build?target=<name\|id\|url>` | Resolve + convert a Darkmoon build → import IDs (JSON) |
| `GET /_abi/widget.js`, `/_abi/widget.css` | The injected widget assets |
| `GET /healthz` | Liveness check (used by the Docker healthcheck) |
| `GET /*` | Reverse-proxy to the upstream builder for its assets |

## A note on courtesy

This mirrors a community fan tool (ascension.nie.one) for your own/guild use.
It always pulls the current upstream page rather than shipping a frozen copy, so
the original author's work stays intact and up to date. Keep it to personal /
community use.
