# MLB The Show 26 · Program Tracker

Bookmarklet-powered program progress tracker. A one-click bookmarklet scrapes your Team Affinity, #1 Fan,
and other program progress from mlb26.theshow.com and pushes it to a Cloudflare Worker you deploy yourself,
which serves a React dashboard.

No browser extension required — sync runs from a bookmark, entirely in the background. A single deployment
can support multiple people at once (see **Sharing with friends** below) — nobody else needs a Cloudflare
account.

## Project structure

```
mlb26-tracker/
├── README.md
├── shared/
│   └── sync-script.js  # Bookmarklet scraping logic, shared by both deployment options below
├── worker/              # Option A: Cloudflare Worker deployment
│   ├── wrangler.toml    # Deployment config + KV binding
│   └── src/
│       ├── index.js     # Worker entry point (routes: /ingest-programs, /programs-data, /sync.js, /)
│       └── app.html     # Tracker React app (self-contained SPA, includes bookmarklet setup instructions)
├── server/              # Option B: self-hosted (Docker) deployment
│   ├── server.js        # Express server, same routes as the Worker, file-based storage instead of KV
│   ├── store.js
│   └── Dockerfile
└── docker-compose.yml
```

Pick **one** of the two options below — they're independent, equally-supported ways to run the exact same
tracker app. Cloudflare requires no server of your own but does require a (free) Cloudflare account.
Docker requires a machine to run it on (a spare PC, NAS, or Raspberry Pi) but no third-party account at all.

## Option A: Cloudflare Worker (no server of your own needed)

This assumes no prior setup — if you already have some of these tools installed, skip ahead.

### 0. Prerequisites

- **A Cloudflare account** (free tier is enough). If you don't have one, sign up at
  [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — just an email + password, no
  credit card required for the free tier used here.
- **Node.js** (which includes `npm`), needed to run the deploy tooling. If you don't have it, download
  the "LTS" installer from [nodejs.org](https://nodejs.org) and run it. To check if you already have it:
  ```bash
  node -v
  ```
  If that prints a version number (e.g. `v20.11.0`), you're set.
- **Git**, to download this repo. macOS and most Linux systems already have it (`git --version` to
  check). On Windows, install [Git for Windows](https://git-scm.com/download/win).
- A terminal / command line app: **Terminal** on macOS, **Command Prompt**, **PowerShell**, or
  **Git Bash** on Windows.

### 1. Get the code

```bash
git clone https://github.com/king829-dev/mlb26-tracker.git
cd mlb26-tracker/worker
```
(No GitHub account needed to clone a public repo — this just downloads the files.)

### 2. Install Wrangler (Cloudflare's deploy tool) and log in

```bash
npm install -g wrangler
wrangler login
```
`wrangler login` opens a browser tab asking you to authorize Wrangler against your Cloudflare account —
click **Allow**, then return to the terminal.

### 3. Create your own KV namespace (this is where your synced data is stored)

```bash
wrangler kv namespace create INVENTORY
```
This prints something like:
```
[[kv_namespaces]]
binding = "INVENTORY"
id = "a1b2c3d4e5f6..."
```
Copy that `id` value.

### 4. Configure the project

Open `wrangler.toml` in any text editor and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the `id` you
just copied.

### 5. Choose how you want the tracker to be reachable

- **No personal domain? No problem.** Leave the `[[routes]]` block in `wrangler.toml` commented out.
  Cloudflare automatically gives every Worker a free URL at
  `https://<worker-name>.<your-subdomain>.workers.dev` (the `<your-subdomain>` part is a
  Cloudflare-assigned account subdomain, visible in your Cloudflare dashboard under **Workers & Pages**
  after your first deploy). This URL works exactly the same as a custom domain — nothing else to
  configure.
- **Have your own domain?** It must already be added to your Cloudflare account (Cloudflare's
  [Add a Site](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/) docs cover this).
  Then uncomment the `[[routes]]` block in `wrangler.toml` and set `pattern` to your domain instead.

### 6. Deploy

```bash
wrangler deploy
```
Wrangler prints your deployed URL when it finishes (either your `*.workers.dev` URL or your custom
domain). Open it — the bookmarklet shown in the **Sync Data** panel automatically points at whichever
origin is serving it, so no code changes are needed either way.

To preview locally before deploying:
```bash
wrangler dev
```

### 7. Lock down your ingest endpoints (strongly recommended)

By default, your tracker's write endpoints (`/ingest-programs`, `/ingest-general-programs`) accept requests
from anyone who finds your URL — there's no login system here, just a link. Setting a secret key closes
that off: only requests carrying a matching key (which your own served sync script includes automatically)
are accepted.

```bash
wrangler secret put SYNC_KEY
```
When prompted, paste any random string — e.g. the output of `openssl rand -hex 32` (macOS/Linux) — then
redeploy with `wrangler deploy`. Nothing else changes for you or anyone syncing through your deployed URL;
this only rejects direct requests to those two endpoints from anyone who hasn't loaded your sync script
first.

There's also a built-in rate limit (20 writes per source IP per 10 minutes) on those same endpoints,
active regardless of whether you set a `SYNC_KEY` — this protects your free-tier Cloudflare KV write quota
from being exhausted by a flood of requests.

### 8. Password-protect your dashboard and data (optional)

`SYNC_KEY` (above) only protects *writes*. By default, anyone who has (or guesses) your tracker's URL can
still *view* your synced progress data — there's no login. If you'd rather require a username/password to
view the dashboard, set these two secrets:

```bash
wrangler secret put BASIC_AUTH_USER
wrangler secret put BASIC_AUTH_PASS
```
Redeploy (`wrangler deploy`) and your browser will prompt for that username/password the next time you (or
anyone) opens the tracker URL — a standard browser login popup, no code changes needed. This does **not**
apply to the bookmarklet/sync process itself (which can't type a password into a prompt) — syncing keeps
working exactly as before, protected separately by `SYNC_KEY`.

If you skip this, the tracker works exactly as it does today — this step only matters if you want to keep
your progress data private from anyone who has the link.

## Option B: Self-hosted (Docker)

Already have somewhere to run Docker — a PC, NAS, or Raspberry Pi (64-bit OS)? This runs the identical
tracker app with no Cloudflare account, using [Docker Compose](https://docs.docker.com/compose/install/) and
a local file for storage instead of Cloudflare KV.

```bash
git clone https://github.com/king829-dev/mlb26-tracker.git
cd mlb26-tracker
```

Strongly recommended before your first run: set a secret key to lock down the write endpoints (otherwise
anyone who finds your URL can write to it — see **Lock down your ingest endpoints** above, same idea here).
```bash
export SYNC_KEY=$(openssl rand -hex 32)
docker compose up --build -d
```
(There's also a built-in rate limit of 20 writes per source IP per 10 minutes on those endpoints regardless
of whether `SYNC_KEY` is set.) If you skip this, the tracker still runs fine — you'll just be running it
unauthenticated, same as not setting `SYNC_KEY` on the Cloudflare option.

Also optional: password-protect the dashboard and data (not just writes) with HTTP Basic Auth — your
browser will prompt for a username/password the first time you open the tracker URL. This is separate from
`SYNC_KEY` and doesn't affect the bookmarklet/sync process at all.
```bash
export BASIC_AUTH_USER=yourname
export BASIC_AUTH_PASS=$(openssl rand -hex 16)
docker compose up --build -d
```
(If you're setting `SYNC_KEY` too, export both before running `docker compose up`.) Skip this if you don't
mind anyone with the link being able to view your synced progress data — write access is still gated by
`SYNC_KEY` either way.

The container serves both plain HTTP (`8787`) and HTTPS (`8443`, self-signed cert generated automatically
on first boot). **Use the HTTPS URL** — e.g. `https://<the machine's IP or hostname>:8443` — for anything
that involves the bookmarklet. This matters because the bookmarklet is loaded from
`mlb26.theshow.com`, which is HTTPS, and browsers block an HTTPS page from loading an HTTP script
("mixed content") — so a plain-`http://` bookmarklet silently fails to sync. Since the cert is
self-signed (not issued by a trusted authority), your browser will show a warning the first time you visit
— click **Advanced → Proceed** to accept it. This is a one-time step per browser/device; after that,
syncing works normally. (The plain HTTP port is still there if you just want to view the dashboard without
dealing with the cert warning — only the sync path needs HTTPS.)

Data — and the generated cert — are stored in a Docker named volume (`mlb26-data`), so both persist across
container restarts/rebuilds (meaning you won't have to re-accept the cert warning after every restart).

To stop it:
```bash
docker compose down
```
(Your data isn't deleted — it's in the named volume, not the container. `docker compose up` again to resume.)

Everything else — installing the bookmarklet, sharing with friends, friendly `/name` links — works exactly
the same as Option A; just use your Docker host's HTTPS URL (e.g. `https://raspberrypi.local:8443`)
wherever the guide below says "your deployed tracker."

> **Raspberry Pi note:** the Docker image (`node:22-alpine`) supports 64-bit ARM (`arm64`). Make sure your
> Pi is running a 64-bit OS (most current Raspberry Pi OS installs are) — a 32-bit OS won't work with this
> image.
>
> **Want a real (non-self-signed) certificate instead?** If you already have a domain and a Cloudflare
> account, a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
> pointed at this container gives you a trusted HTTPS URL with no browser warnings — see that project's docs
> for adding `cloudflared` as an extra service in `docker-compose.yml`.
>
> **Deploying via Portainer instead of the CLI?** Set `SYNC_KEY` under the stack's **Environment variables**
> section in the Portainer UI rather than `export`ing it in a shell, since Portainer doesn't inherit your
> terminal's environment.

## How syncing works

1. Open your deployed tracker and go to **🔗 Sync Data** in the sidebar for full setup steps (also
   summarized below).
2. Install the **"Sync MLB26"** bookmarklet in your browser's bookmarks bar.
3. From any `mlb26.theshow.com` tab, click the bookmark. It loads `/sync.js` from your worker, which:
   - Scrapes Team Affinity progress (and mission breakdown) for all 30 teams, AL + NL
   - Scrapes #1 Fan progress and mission breakdown for each team
   - Scrapes all other programs (XP Path, Themed, Assorted, Multiplayer, Spotlight, etc.)
   - POSTs everything to your worker's `/ingest-programs` and `/ingest-general-programs` endpoints
4. Refresh the tracker to see updated progress.

### Installing the bookmarklet

- **Mac / Windows Chrome:** show the bookmarks bar (`⌘⇧B` / `Ctrl⇧B`), then drag the "Sync MLB26" button
  from the tracker's Sync Data panel straight onto the bar.
- **Windows (alternate):** right-click the bookmarks bar → *Add page*, name it "Sync MLB26", and paste the
  copied bookmarklet code into the URL field.
- **iOS (Chrome or Safari):** iOS won't let you type or drag a `javascript:` link directly into a new
  bookmark. There are two ways around this:
  - **Set it up on iOS directly:** bookmark any page first (☆ icon), then edit that bookmark and replace
    its saved URL with the copied bookmarklet code.
  - **Use a bookmark synced from another device (easier):** if you already created the bookmarklet on a
    Mac/Windows Chrome and are signed into the same Google account on Chrome for iOS, that bookmark syncs
    over automatically — just tap it from your iOS bookmarks list. No need to recreate it on the device
    itself.

## Sharing with friends (no Cloudflare account needed for them)

One Worker deployment can serve multiple people's data at once — each person gets an opaque `uid` generated
in their own browser, so their synced data never collides with anyone else's. Nobody but the original
deployer ever needs to touch Cloudflare or `wrangler`.

1. Send your friend your deployed tracker URL.
2. Have them open **🔗 Sync Data** in the sidebar. Since it's their first time, they'll see a
   **"Sharing this tracker with someone else?"** prompt — have them click **+ Create My Own Tracker**.
3. This generates their personal `uid`, stores it in their browser's local storage, and updates the page URL
   to `?uid=...`. The bookmarklet shown below that point is now personalized — installing it (per the steps
   above) syncs only their data.
4. They should bookmark their personal tracker link (shown in that same panel, e.g.
   `https://your-domain.com/?uid=abc123...`) so if they ever clear their browser data or switch devices,
   revisiting that link restores their profile.

You can also hand someone a friendly link ahead of time, e.g. `https://your-domain.com/friendname` — visiting a
path like that automatically assigns that name as their `uid`, no button click required. The name must be
plain letters/numbers only.

Anyone who never gets a `uid` (via either method) uses the original/default (unscoped) profile — that's why
this only matters for the *second+* person using a shared deployment.

## KV namespace

Keys stored (all optionally suffixed `_<uid>` for a given user's profile; no suffix = default/legacy profile):
- `programs` / `programs_prev` — Team Affinity + #1 Fan snapshot: `{ teams: {...}, savedAt }`
- `general_programs` — non-team-affinity program snapshot: `{ programs: {...}, savedAt }`

## API endpoints

All data endpoints accept an optional `?uid=` query param to scope reads/writes to a specific user's
profile (see **Sharing with friends** above). Omitting it uses the default/legacy profile.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the tracker React app |
| `/sync.js` | GET | Serves the bookmarklet's sync script (self-pointing to this deployment's origin + uid) |
| `/ingest-programs` | POST | Receives `{ teams: {}, savedAt: "" }` scraped by the bookmarklet |
| `/programs-data` | GET | Returns stored Team Affinity / #1 Fan progress to the app |
| `/programs-prev` | GET | Returns the previous snapshot, for delta tracking |
| `/ingest-general-programs` | POST | Receives `{ programs: {}, savedAt: "" }` scraped by the bookmarklet |
| `/general-programs-data` | GET | Returns stored non-team-affinity program progress to the app |
