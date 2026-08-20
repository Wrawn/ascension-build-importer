# Exposing the app with Cloudflare Tunnel + Access

This gives your friends an `https://builds.yourdomain.com` URL with **no open
ports** on your network and a **login allowlist** — the recommended way to share
this. Assumes your domain is already on Cloudflare.

The two pieces:

- **Tunnel** (`cloudflared`) — an outbound-only connector from Unraid to
  Cloudflare, so nothing is exposed inbound.
- **Access** — a login gate (email code, Google, GitHub…) in front of the
  hostname, so only people you allow ever reach the app.

---

## 1. Create the Tunnel

1. Go to **Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a
   tunnel**.
2. Choose **Cloudflared**, name it (e.g. `unraid`), **Save**.
3. On the "Install connector" screen, copy the **tunnel token** (the long string
   after `--token`). You'll run the connector with it below.
4. Under **Public Hostnames → Add a public hostname**:
   - **Subdomain:** `builds` (→ `builds.yourdomain.com`)
   - **Domain:** your domain
   - **Type:** `HTTP`
   - **URL:** `ascension-build-importer:8787`
     - Use the container name if `cloudflared` shares a Docker network with the
       app; otherwise use `YOUR_UNRAID_IP:8787` (e.g. `192.168.1.8:8787`).
   - **Save**.

## 2. Run the connector on Unraid

Easiest: **Community Applications → search "cloudflared"** and use a tunnel
template, pasting your token. Or from the Unraid terminal:

```bash
docker run -d --name cloudflared --restart unless-stopped \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <YOUR_TUNNEL_TOKEN>
```

> To use the container name as the tunnel URL, put `cloudflared` and
> `ascension-build-importer` on the same Docker network (e.g.
> `docker network create web` then `--network web` on both). Otherwise just point
> the hostname at `YOUR_UNRAID_IP:8787` and skip this.

Within a few seconds the tunnel shows **Healthy** in the dashboard, and
`https://builds.yourdomain.com` serves the app over HTTPS.

## 3. Gate it with Access (the allowlist)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. **Application domain:** `builds.yourdomain.com`.
3. Add a **policy**:
   - **Action:** Allow
   - **Include:** *Emails* → list your friends' emails (or *Emails ending in* a
     domain, or a Google/GitHub identity provider).
4. Save. Now visiting the URL forces a login, and only listed people get in.

Optional — make the **roster** stricter than the planner: add a second
self-hosted application for the path `builds.yourdomain.com/builds` with a policy
of **just your email**. (The `ADMIN_TOKEN` already restricts roster *data*, so
this is belt-and-suspenders.)

## 4. App settings that pair with this

Run the container with a token set (roster stays yours) — Access + `ADMIN_TOKEN`
together mean *friends can import, only you manage the roster*:

```bash
docker run -d --name ascension-build-importer --restart unless-stopped \
  -p 8787:8787 \
  -v /mnt/user/appdata/ascension-build-importer/data:/data \
  -e ADMIN_TOKEN="pick-a-long-random-string" \
  -e TRUST_PROXY=1 \
  ghcr.io/wrawn/ascension-build-importer:latest
```

- `TRUST_PROXY=1` is correct here — cloudflared sets `X-Forwarded-For`, so
  rate limiting keys on the real client IP.
- You no longer need `-p 8787:8787` published to your LAN once the tunnel points
  at the container name on a shared network, but leaving it is harmless.

## Notes

- **No port forwarding.** Don't open 8787 (or anything) on your router — the
  tunnel is outbound-only. That's the whole point.
- Cloudflare terminates TLS, so friends always get HTTPS.
- Access logs (Zero Trust → Logs) show who reached the app.
- Keep the image updated (Unraid Docker → Update); CI publishes fixes to GHCR.
