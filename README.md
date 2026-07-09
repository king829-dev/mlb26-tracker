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
└── worker/             # Cloudflare Worker
    ├── wrangler.toml    # Deployment config + KV binding
    └── src/
        ├── index.js     # Worker entry point (routes: /ingest-programs, /programs-data, /sync.js, /)
        └── app.html     # Tracker React app (self-contained SPA, includes bookmarklet setup instructions)
```

## Setup

1. [Install wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) if you don't
   already have it, and log in to your own Cloudflare account:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. Create your own KV namespace:
   ```bash
   cd worker
   wrangler kv namespace create INVENTORY
   ```
3. Copy the namespace `id` that command prints into `wrangler.toml` (replace
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`).
4. Choose how you want the tracker to be reachable:
   - **No personal domain? No problem.** Leave the `[[routes]]` block in `wrangler.toml` commented out.
     Cloudflare automatically gives every Worker a free URL at
     `https://<worker-name>.<your-subdomain>.workers.dev` (the `<your-subdomain>` part is a
     Cloudflare-assigned account subdomain, visible in your dashboard after your first deploy). This
     URL works exactly the same as a custom domain — nothing else to configure.
   - **Have your own domain?** Uncomment the `[[routes]]` block in `wrangler.toml` and set `pattern` to
     your domain instead.
5. Deploy:
   ```bash
   wrangler deploy
   ```
6. Wrangler prints your deployed URL when it finishes (either your `*.workers.dev` URL or your custom
   domain). Open it — the bookmarklet shown in the **Sync Data** panel automatically points at whichever
   origin is serving it, so no code changes are needed either way.

To preview locally before deploying:
```bash
wrangler dev
```

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
