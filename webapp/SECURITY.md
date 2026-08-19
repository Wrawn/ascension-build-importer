# Exposing this to the internet — security notes

Short version: **nothing web-facing is ever "unhackable,"** but this app is built
to be safe to share with friends **if you put an authenticating layer in front of
it.** Do that, keep the app updated, and the risk is low.

## Do this before exposing it

### 1. Put an auth/access layer in front (most important)

The app has no login of its own on purpose — front it with something that does
access control properly:

- **Cloudflare Tunnel + Cloudflare Access** (recommended): no open ports on your
  network at all, free, and you allowlist friends by email/Google login. This is
  the safest option for a small group.
- **Authelia / Authentik** in front of a reverse proxy (SWAG, Nginx Proxy
  Manager, Traefik).
- **HTTP Basic Auth** at Nginx Proxy Manager with one shared password you hand to
  friends — minimal, but real.

Any of these means only your people can reach the app, which by itself neutralizes
most of the risk (roster tampering, abuse, scraping).

### 2. Set an admin token

Set `ADMIN_TOKEN` to a long random string. Then:

- The planner and importing (`/api/build`) stay open to your friends.
- Viewing the roster (`/builds`, `/api/builds`) and **renaming/deleting** builds
  require the token. The `/builds` page asks for it once and remembers it in your
  browser.

```bash
ADMIN_TOKEN=$(head -c 24 /dev/urandom | base64)   # generate one
```

Without this, anyone who can reach the app can delete your saved builds.

### 3. Use HTTPS and set TRUST_PROXY correctly

- Terminate TLS at your reverse proxy (Cloudflare/NPM/Traefik all do this).
- `TRUST_PROXY` defaults to **on** (the app reads `X-Forwarded-For` for rate-limit
  keying). Keep it on **only** when a proxy you control sets that header. If the
  container is ever directly internet-facing, set `TRUST_PROXY=0` so a client
  can't spoof its IP to dodge rate limits.

## What the app already does

- **Admin-gated roster + mutations** (`ADMIN_TOKEN`) — see above.
- **Per-IP rate limiting** — `RATE_MAX` requests per `RATE_WINDOW_MS` (default
  120/min). `/healthz` is exempt.
- **Bounded storage** — at most `MAX_BUILDS` (default 2000) saved builds, and
  name/label lengths are clamped, so imports can't fill the disk.
- **No open SSRF** — Darkmoon/builder requests always use a fixed host; user input
  only reaches the URL *path*, percent-encoded.
- **Locked-down static + proxy** — only three known files are served from disk
  (basename-only, no path traversal), and the upstream proxy only forwards
  asset-looking paths, so it can't be used as a general web proxy.
- **Output escaping** — the roster page HTML-escapes every dynamic value.
- **Security headers** — `nosniff`, `no-referrer`, `SAMEORIGIN` framing.

## Environment variables that matter for exposure

| Var | Default | Notes |
| --- | --- | --- |
| `ADMIN_TOKEN` | _(empty = open)_ | **Set this before exposing.** Protects the roster + delete/rename. |
| `TRUST_PROXY` | `1` | Read `X-Forwarded-For`. Set `0` if directly internet-facing. |
| `RATE_MAX` | `120` | Requests per window per IP. |
| `RATE_WINDOW_MS` | `60000` | Rate-limit window. |
| `MAX_BUILDS` | `2000` | Cap on stored builds. |

## Honest residual risks

- Friends who *can* reach the app can still import builds (that's the point);
  imports are only bounded by the rate limiter and `MAX_BUILDS`.
- The roster is shared: everyone with the admin token sees all saved builds.
- It proxies public pages/assets from ascension.nie.one and reads public Darkmoon
  data — nothing private is involved, but your server's IP is the one making those
  upstream requests.
- This is a hobby tool. Don't run it on the same box as anything sensitive, keep
  the image updated (CI publishes fixes to GHCR), and prefer the Cloudflare Access
  route over poking a port in your firewall.
