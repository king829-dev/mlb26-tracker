---
name: verify
description: Build, run, and drive the MLB26 tracker (Worker dashboard + sync bookmarklet) to verify changes end-to-end.
---

# Verifying mlb26-tracker changes

## Build + run

```bash
cd worker
npm install                 # esbuild + react (dashboard build), first time only
npm run build               # regenerates src/app.html from app/app.jsx + app/template.html — REQUIRED after editing app/
echo 'SYNC_KEY=testsecret123' > .dev.vars   # gitignored; enables the write-auth path
npm i --no-save wrangler
npx wrangler dev --port 8787   # local Worker + in-memory KV, no Cloudflare login needed
```

Dashboard: http://127.0.0.1:8787/ — serves the generated `src/app.html`.

## Driving the sync script (the hard part)

The sync script only runs on a `*.theshow.com` page and POSTs cross-origin to the tracker.
Use Playwright (`chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] })`)
with route interception:

- Intercept `https://mlb26.theshow.com/**` and serve fake game pages. The scraper needs:
  hub pages at `/programs/team_affinity_by_team?league=<al|nl>&team_id=<0-29>` containing
  `<a href="/program_view?program_id=N">Name Program\n40%</a>` anchors (one plain + one `#1 Fan`),
  and detail pages with `.breadcrumb-block` (team name = last `/`-segment) and
  `.accordion-block > .accordion-toggle-label` + `<meter>` pairs for missions.
- **Gotcha:** a fetch from the intercepted HTTPS page to `http://127.0.0.1:8787` hangs forever in
  headless Chromium (mixed-content upgrade stalls; PNA/mixed-content disable flags do NOT help).
  Fix: also intercept a fake HTTPS alias `https://tracker.test/**` and proxy each request to
  `http://127.0.0.1:8787` with node `fetch` inside the route handler (rewrite the alias into the
  `/sync.js` body so `INGEST_ORIGIN` points at the alias). CORS + preflights work through this.
- Inject the bookmarklet equivalent: `window.__MLB26_SYNC_KEY = ...; script.src = TRACKER + '/sync.js?t=' + Date.now()`.
- Await overlay result: `#mlb26sync-title` text matches `/Done|Error/` (allow ~60-120s; the script
  sleeps between batches). Message text is in `#mlb26sync-step`.

A full working harness (fake pages, https alias proxy, failure-injection scenarios) existed at
scratchpad `e2e/test.mjs` in the session that created this skill — recreate from the notes above.

## Worth re-checking after changes

- Wrong sync key → overlay must show Error naming the sync key (and nothing lands in KV).
- 500s on `/ingest-programs` (inject via `page.route` fulfill) → overlay reports "N save requests failed".
- Dashboard poll: sync again while a dashboard tab is open → within ~35s all four of
  `/programs-data /programs-prev /general-programs-data /history-data` refetch and tiles update.
- Blocked data endpoints on load → red "Couldn't reach the server" banner, Retry clears it.
