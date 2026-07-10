// Shared bookmarklet payload, served at /sync.js by both deployment targets
// (the Cloudflare Worker in worker/ and the self-hosted Docker server in server/).
// __ORIGIN__ and __UID__ are substituted per-request by whichever server is serving it.
// The SYNC_KEY (if the deployer configured one) is NOT embedded here — /sync.js is publicly
// fetchable, so baking a secret into it would leak it to anyone with the URL. Instead the
// bookmarklet itself sets window.__MLB26_SYNC_KEY before loading this script, and this script
// reads it at runtime and sends it back on writes so the ingest endpoints can reject requests
// that didn't come with a valid key.
// Runs entirely via same-origin fetch()+DOMParser from a theshow.com tab — no extension needed.
//
// Stage 2 design: an on-page overlay (mlb26sync-* ids/classes, inline styles, no external CSS)
// replaces alert() for all progress/result reporting since both users sync from iOS Safari/Chrome
// where the console is invisible. A cheap "hub scan" (one lightweight request per team) checks
// each team's Team Affinity / #1 Fan pct against the last-saved snapshot; only teams whose pct
// changed (or are missing from the snapshot, or a forced full sync) get the more expensive
// mission-detail scrape. Detail batches are POSTed as they complete (partial + syncId) so a
// mid-run network failure doesn't lose already-scraped progress; the Worker merges each batch
// into the run's in-progress doc, seeded from the previously-stored teams on the first batch of
// a new run, so unchanged teams are preserved without the client needing to resend them.
const SYNC_SCRIPT = `(async function() {
  var INGEST_ORIGIN = '__ORIGIN__';
  var UID = '__UID__';
  var SYNC_KEY = (typeof window !== 'undefined' && window.__MLB26_SYNC_KEY) || '';
  var UID_QS = UID ? ('?uid=' + encodeURIComponent(UID)) : '';
  var BATCH = 4;
  var STALE_MS = 7 * 24 * 60 * 60 * 1000;

  var syncRunning = false;
  var wakeLock = null;

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // ── On-page overlay (2b) ────────────────────────────────────────────────────
  var overlayEls = null;
  function createOverlay() {
    var box = document.createElement('div');
    box.id = 'mlb26sync-overlay';
    box.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;width:270px;' +
      'background:#181818;color:#fff;border:1px solid #444;border-radius:8px;padding:12px 14px;' +
      'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.45);';

    var title = document.createElement('div');
    title.id = 'mlb26sync-title';
    title.textContent = 'MLB26 Sync';
    title.style.cssText = 'font-weight:700;margin-bottom:6px;';
    box.appendChild(title);

    var step = document.createElement('div');
    step.id = 'mlb26sync-step';
    step.textContent = 'Starting...';
    step.style.cssText = 'font-size:12px;color:#aaa;margin-bottom:8px;min-height:16px;line-height:1.3;';
    box.appendChild(step);

    var barTrack = document.createElement('div');
    barTrack.style.cssText = 'height:6px;background:#333;border-radius:3px;overflow:hidden;';
    var bar = document.createElement('div');
    bar.id = 'mlb26sync-bar';
    bar.style.cssText = 'height:100%;width:0%;background:#4a9eff;transition:width .3s;';
    barTrack.appendChild(bar);
    box.appendChild(barTrack);

    var choiceRow = document.createElement('div');
    choiceRow.id = 'mlb26sync-choice';
    choiceRow.style.cssText = 'margin-top:8px;display:none;';
    var fullBtn = document.createElement('button');
    fullBtn.id = 'mlb26sync-fullbtn';
    fullBtn.textContent = 'Force Full Sync';
    fullBtn.style.cssText = 'font-size:11px;padding:4px 8px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer;';
    choiceRow.appendChild(fullBtn);
    box.appendChild(choiceRow);

    var dismissRow = document.createElement('div');
    dismissRow.id = 'mlb26sync-dismiss';
    dismissRow.style.cssText = 'margin-top:8px;text-align:right;display:none;';
    var dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.style.cssText = 'font-size:11px;padding:4px 8px;background:transparent;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer;';
    dismissBtn.onclick = function() { removeOverlay(); };
    dismissRow.appendChild(dismissBtn);
    box.appendChild(dismissRow);

    document.body.appendChild(box);
    overlayEls = { box: box, title: title, step: step, bar: bar, choiceRow: choiceRow, fullBtn: fullBtn, dismissRow: dismissRow };
  }
  function setStep(text) { if (overlayEls) overlayEls.step.textContent = text; }
  function setProgress(pct) { if (overlayEls) overlayEls.bar.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
  function setDone(success, text) {
    if (!overlayEls) return;
    overlayEls.title.textContent = success ? 'MLB26 Sync — Done' : 'MLB26 Sync — Error';
    overlayEls.title.style.color = success ? '#4ade80' : '#f87171';
    overlayEls.step.textContent = text;
    overlayEls.bar.style.background = success ? '#4ade80' : '#f87171';
    overlayEls.bar.style.width = '100%';
    overlayEls.choiceRow.style.display = 'none';
    overlayEls.dismissRow.style.display = 'block';
  }
  function removeOverlay() {
    if (overlayEls && overlayEls.box.parentNode) overlayEls.box.parentNode.removeChild(overlayEls.box);
    overlayEls = null;
  }
  function log(msg) {
    console.log('[MLB26 Sync]', msg);
    setStep(msg);
  }
  function askFullSync() {
    return new Promise(function(resolve) {
      if (!overlayEls) { resolve(false); return; }
      overlayEls.choiceRow.style.display = 'block';
      var resolved = false;
      overlayEls.fullBtn.onclick = function() {
        if (resolved) return;
        resolved = true;
        overlayEls.choiceRow.style.display = 'none';
        resolve(true);
      };
      setTimeout(function() {
        if (resolved) return;
        resolved = true;
        overlayEls.choiceRow.style.display = 'none';
        resolve(false);
      }, 4000);
    });
  }

  // ── Network resilience (2d) ─────────────────────────────────────────────────
  function fetchOnce(url, opts, ms) {
    ms = ms || 20000;
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, ms);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(function() { clearTimeout(t); });
  }
  async function fetchT(url, opts, ms) {
    try {
      var r = await fetchOnce(url, opts, ms);
      if (r.status >= 500 && r.status < 600) {
        await sleep(1500);
        return await fetchOnce(url, opts, ms);
      }
      return r;
    } catch (e) {
      await sleep(1500);
      return await fetchOnce(url, opts, ms);
    }
  }

  async function acquireWakeLock() {
    try {
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* not supported / denied — best effort only */ }
  }
  async function releaseWakeLock() {
    try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (e) {}
  }
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && syncRunning && !wakeLock) acquireWakeLock();
  });

  // ── Scraping ─────────────────────────────────────────────────────────────────
  function parseMissions(doc) {
    return Array.prototype.slice.call(doc.querySelectorAll('meter')).map(function(m) {
      var block = m.closest('.accordion-block');
      var label = block && block.querySelector('.accordion-toggle-label');
      var value = parseFloat(m.value) || 0;
      var max = parseFloat(m.max) || 1;
      return { name: label ? label.textContent.trim() : '?', value: value, max: max, done: value >= max };
    });
  }

  // Cheap: just the hub page listing each program + its pct — no mission detail.
  async function scrapeTeamHub(league, teamId) {
    try {
      var r1 = await fetchT('/programs/team_affinity_by_team?group_id=10015&league=' + league + '&team_id=' + teamId, { credentials: 'include' });
      if (!r1.ok) return null;
      var html1 = await r1.text();
      if (html1.indexOf('program_view') === -1) return null;
      var doc1 = new DOMParser().parseFromString(html1, 'text/html');
      var programs = Array.prototype.slice.call(doc1.querySelectorAll('a[href*="program_view"]')).map(function(a) {
        var lines = (a.textContent || '').trim().split('\\n').map(function(s){return s.trim();}).filter(Boolean);
        var pctStr = lines.find(function(l){return /^\\d+%$/.test(l);});
        var m = a.href.match(/program_id=(\\d+)/);
        var u = new URL(a.href);
        return { name: lines[0] || '', pct: pctStr ? parseInt(pctStr) : 0, programId: m ? m[1] : null, path: u.pathname + u.search };
      });
      if (!programs.length) return null;
      return programs;
    } catch (e) {
      return null;
    }
  }

  // Expensive: mission detail pages, reusing the program list already fetched by scrapeTeamHub.
  async function scrapeTeamDetail(league, teamId, programs) {
    try {
      var main = programs.find(function(p){ return p.name.indexOf('#1 Fan') === -1; });
      var fan = programs.find(function(p){ return p.name.indexOf('#1 Fan') !== -1; });

      var teamName = '', missions = [];
      if (main && main.path) {
        var r2 = await fetchT(main.path, { credentials: 'include' });
        if (r2.ok) {
          var html2 = await r2.text();
          var doc2 = new DOMParser().parseFromString(html2, 'text/html');
          var crumb = doc2.querySelector('.breadcrumb-block');
          teamName = crumb ? crumb.textContent.split('/').pop().trim() : '';
          missions = parseMissions(doc2);
        }
      }

      var fanMissions = [];
      if (fan && fan.path) {
        var r3 = await fetchT(fan.path, { credentials: 'include' });
        if (r3.ok) {
          var html3 = await r3.text();
          var doc3 = new DOMParser().parseFromString(html3, 'text/html');
          fanMissions = parseMissions(doc3);
        }
      }

      return { programs: programs, teamName: teamName, missions: missions, fanMissions: fanMissions };
    } catch (e) {
      return null;
    }
  }

  function pctsOf(programs) {
    if (!programs || !programs.length) return null;
    var main = programs.find(function(p){ return (p.name||'').indexOf('#1 Fan') === -1; });
    var fan = programs.find(function(p){ return (p.name||'').indexOf('#1 Fan') !== -1; });
    return { main: main ? main.pct : 0, fan: fan ? fan.pct : 0 };
  }

  async function scanAllHubs() {
    var ranges = [['al', 0, 14], ['nl', 15, 29]];
    var hubMap = {};
    var total = 30, scanned = 0;
    for (var ri = 0; ri < ranges.length; ri++) {
      var league = ranges[ri][0], startId = ranges[ri][1], endId = ranges[ri][2];
      var teamIds = [];
      for (var i = startId; i <= endId; i++) teamIds.push(i);
      for (var b = 0; b < teamIds.length; b += BATCH) {
        var batch = teamIds.slice(b, b + BATCH);
        var results = await Promise.allSettled(batch.map(function(teamId) { return scrapeTeamHub(league, teamId); }));
        results.forEach(function(r, idx) {
          var teamId = batch[idx];
          hubMap[league + '_' + teamId] = (r.status === 'fulfilled') ? r.value : null;
        });
        scanned += batch.length;
        log('Scanning teams ' + scanned + '/' + total + '...');
        setProgress(Math.round(scanned / total * 40)); // hub scan = first 40% of the bar
        await sleep(400);
      }
    }
    return hubMap;
  }

  function computeChanged(hubMap, storedTeams, forceFull) {
    var changed = [];
    Object.keys(hubMap).forEach(function(key) {
      var programs = hubMap[key];
      if (!programs) return; // couldn't scan this team this run — leave its stored data alone
      if (forceFull) { changed.push(key); return; }
      var stored = storedTeams[key];
      if (!stored) { changed.push(key); return; }
      var newPcts = pctsOf(programs);
      var oldPcts = pctsOf(stored.programs);
      if (!oldPcts || newPcts.main !== oldPcts.main || newPcts.fan !== oldPcts.fan) changed.push(key);
    });
    return changed;
  }

  async function postTeamsBatch(batchTeams, syncId, summary) {
    var body = { syncId: syncId, partial: true, teams: batchTeams, savedAt: new Date().toISOString() };
    if (summary) body.summary = summary;
    await fetchT(INGEST_ORIGIN + '/ingest-programs' + UID_QS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
      body: JSON.stringify(body)
    });
  }

  async function syncChangedTeams(hubMap, changedKeys, syncId, hubScannedCount) {
    var teamsScraped = 0;
    for (var b = 0; b < changedKeys.length; b += BATCH) {
      var batchKeys = changedKeys.slice(b, b + BATCH);
      log('Syncing ' + Math.min(b + BATCH, changedKeys.length) + '/' + changedKeys.length + ' changed teams...');
      var results = await Promise.allSettled(batchKeys.map(function(key) {
        var parts = key.split('_');
        return scrapeTeamDetail(parts[0], parseInt(parts[1], 10), hubMap[key]);
      }));
      var batchTeams = {};
      results.forEach(function(r, idx) {
        var key = batchKeys[idx];
        if (r.status === 'fulfilled' && r.value) {
          var parts = key.split('_');
          batchTeams[key] = Object.assign({ league: parts[0], teamId: parseInt(parts[1], 10) }, r.value);
          teamsScraped++;
        }
      });
      if (Object.keys(batchTeams).length > 0) {
        var isLast = (b + BATCH) >= changedKeys.length;
        var summary = isLast ? { teamsScanned: hubScannedCount, teamsScraped: teamsScraped, programsFound: null } : null;
        await postTeamsBatch(batchTeams, syncId, summary);
      }
      setProgress(40 + Math.round((b + batchKeys.length) / Math.max(changedKeys.length, 1) * 40)); // 40-80%
      await sleep(600);
    }
    return teamsScraped;
  }

  // ── General (non-team-affinity) programs ────────────────────────────────────
  function collectProgramLinks(doc) {
    var seen = {};
    return Array.prototype.slice.call(doc.querySelectorAll('a[href*="program_view"]')).map(function(a) {
      try {
        var u = new URL(a.href);
        var key = u.pathname + u.search;
        if (seen[key]) return null;
        seen[key] = true;
        var lines = (a.textContent || '').trim().split('\\n').map(function(s){return s.trim();}).filter(Boolean);
        var pctStr = lines.find(function(l){return /^\\d+%$/.test(l);});
        var name = lines.find(function(l){return !/^\\d+%$/.test(l);}) || u.pathname.split('/').filter(Boolean).pop().replace(/_/g, ' ') || key;
        return { path: key, name: name, pct: pctStr ? parseInt(pctStr) : null };
      } catch (e) { return null; }
    }).filter(Boolean);
  }

  function scrapeMissionsFromDoc(doc, fallbackName) {
    var titleEls = Array.prototype.slice.call(doc.querySelectorAll('h1,.page-title,.program-title,.breadcrumb-item:last-child'));
    var titles = titleEls.map(function(el){ return (el.textContent || '').trim(); }).filter(Boolean);
    var title = titles.length ? titles[titles.length - 1] : fallbackName;
    var missions = parseMissions(doc);
    var pctEl = doc.querySelector('[class*="percent"],[class*="pct"],[class*="progress"]');
    var pctMatch = ((pctEl && pctEl.textContent) || (doc.body && doc.body.textContent) || '').match(/(\\d+)%/);
    var pct = pctMatch ? parseInt(pctMatch[1]) : 0;
    if (!pct && missions.length) pct = Math.round(missions.filter(function(m){return m.done;}).length / missions.length * 100);
    return { title: title, missions: missions, pct: pct };
  }

  async function scrapeGeneralPrograms(storedGeneral, forceFull) {
    // Seed from what's already stored so a program that drops off a hub view this run
    // (or simply wasn't re-scanned) isn't silently lost from the final snapshot.
    var result = Object.assign({}, storedGeneral);
    var GROUP_HUBS = [
      { path: '/programs/xp_path?group_id=10000', label: 'XP Path' },
      { path: '/programs/other_programs?group_id=10002', label: 'Themed' },
      { path: '/programs/other_programs?group_id=10005', label: 'Assorted' },
      { path: '/programs/other_programs?group_id=10012', label: 'Multiplayer' },
      { path: '/programs/other_programs?group_id=10019', label: 'Spotlight' },
    ];

    try {
      var hubResp = await fetchT('/programs', { credentials: 'include' });
      if (hubResp.ok) {
        var hubHtml = await hubResp.text();
        var hubDoc = new DOMParser().parseFromString(hubHtml, 'text/html');
        var seenHub = {};
        Array.prototype.slice.call(hubDoc.querySelectorAll('a[href]')).forEach(function(a) {
          try {
            var u = new URL(a.href);
            if (u.hostname !== location.hostname) return;
            if (u.pathname === '/programs' || u.pathname.indexOf('team_affinity') !== -1) return;
            var key = u.pathname + u.search;
            if (seenHub[key]) return;
            seenHub[key] = true;
            GROUP_HUBS.push({ path: key, label: key.split('/').pop() });
          } catch (e) {}
        });
      }
    } catch (e) {}

    var seenPaths = {};
    var hubs = [];
    GROUP_HUBS.forEach(function(g) {
      if (!seenPaths[g.path]) { seenPaths[g.path] = true; hubs.push(g); }
    });

    var toScrape = [];
    var seenProgPaths = {};

    for (var hi = 0; hi < hubs.length; hi++) {
      var group = hubs[hi];
      try {
        log('Scanning ' + group.label + '...');
        var r = await fetchT(group.path, { credentials: 'include' });
        if (!r.ok) continue;
        var html = await r.text();
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var links = collectProgramLinks(doc);
        if (links.length === 0) {
          var detail = scrapeMissionsFromDoc(doc, group.label);
          if (detail.missions.length) {
            var key2 = group.path.replace(/[^a-z0-9]/gi, '_');
            result[key2] = { name: detail.title || group.label, path: group.path, pct: detail.pct, missions: detail.missions };
          }
        } else {
          links.forEach(function(link) {
            if (!seenProgPaths[link.path]) { seenProgPaths[link.path] = true; toScrape.push(link); }
          });
        }
      } catch (e) {}
      await sleep(300);
    }

    var skipped = 0;
    for (var pi = 0; pi < toScrape.length; pi++) {
      var prog = toScrape[pi];
      var key3 = prog.path.replace(/[^a-z0-9]/gi, '_');
      var stored = storedGeneral ? storedGeneral[key3] : null;
      // Skip the detail fetch when the hub already told us the pct hasn't moved (2a).
      if (!forceFull && stored && prog.pct != null && stored.pct === prog.pct) {
        result[key3] = stored;
        skipped++;
        continue;
      }
      log('Program ' + (pi + 1 - skipped) + '/' + (toScrape.length - skipped) + ': ' + prog.name + '...');
      try {
        var rp = await fetchT(prog.path, { credentials: 'include' });
        if (!rp.ok) continue;
        var htmlp = await rp.text();
        var docp = new DOMParser().parseFromString(htmlp, 'text/html');
        var detailp = scrapeMissionsFromDoc(docp, prog.name);
        if (detailp.missions.length) {
          result[key3] = { name: detailp.title || prog.name, path: prog.path, pct: (prog.pct != null ? prog.pct : detailp.pct), missions: detailp.missions };
        }
      } catch (e) {}
      await sleep(300);
    }

    return result;
  }

  // ── Main ─────────────────────────────────────────────────────────────────────
  try {
    if (location.hostname.indexOf('theshow.com') === -1) {
      createOverlay();
      setDone(false, 'Run this from a mlb26.theshow.com tab, not ' + location.hostname + '.');
      return;
    }

    syncRunning = true;
    createOverlay();
    acquireWakeLock();

    log('Checking last saved snapshot...');
    var storedTeams = {}, storedGeneral = {}, storedSavedAt = null;
    try {
      var storedResp = await fetchT(INGEST_ORIGIN + '/programs-data' + UID_QS, { cache: 'no-store' });
      if (storedResp.ok) {
        var storedData = await storedResp.json();
        storedTeams = storedData.teams || {};
        storedSavedAt = storedData.savedAt || null;
      }
    } catch (e) {}
    try {
      var storedGenResp = await fetchT(INGEST_ORIGIN + '/general-programs-data' + UID_QS, { cache: 'no-store' });
      if (storedGenResp.ok) {
        var storedGenData = await storedGenResp.json();
        storedGeneral = storedGenData.programs || {};
      }
    } catch (e) {}

    var autoForceFull = (Object.keys(storedTeams).length === 0) ||
      (!!storedSavedAt && (Date.now() - new Date(storedSavedAt).getTime()) > STALE_MS);

    var forceFull;
    if (autoForceFull) {
      log('No recent snapshot found — running a full sync...');
      forceFull = true;
    } else {
      log('Tap "Force Full Sync" to rescan everything, or wait to sync just what changed...');
      forceFull = await askFullSync();
    }

    log('Scanning teams...');
    var hubMap = await scanAllHubs();
    var hubScannedCount = Object.values(hubMap).filter(Boolean).length;

    if (hubScannedCount === 0) {
      log('No team data found.');
      setDone(false, 'No team data found. Make sure you are logged in to mlb26.theshow.com, then try again. Your saved data was not changed.');
      return;
    }

    var changedKeys = computeChanged(hubMap, storedTeams, forceFull);
    var syncId = Date.now().toString(36);
    var teamsScraped = 0;
    if (changedKeys.length === 0) {
      log('Teams already up to date.');
      setProgress(80);
    } else {
      teamsScraped = await syncChangedTeams(hubMap, changedKeys, syncId, hubScannedCount);
    }

    log('Checking general programs...');
    var generalPrograms = await scrapeGeneralPrograms(storedGeneral, forceFull);
    setProgress(95);

    if (Object.keys(generalPrograms).length > 0) {
      log('Saving general programs...');
      await fetchT(INGEST_ORIGIN + '/ingest-general-programs' + UID_QS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
        body: JSON.stringify({ programs: generalPrograms, savedAt: new Date().toISOString() })
      });
    }

    setProgress(100);
    var summaryText = hubScannedCount + ' teams scanned, ' + teamsScraped + ' updated, ' +
      Object.keys(generalPrograms).length + ' other programs. Refresh the tracker to see updates.';
    log('Done.');
    setDone(true, summaryText);
  } catch (e) {
    console.error('[MLB26 Sync] Error:', e);
    setDone(false, 'Sync failed: ' + e.message + ' — your existing saved data was not changed.');
  } finally {
    syncRunning = false;
    releaseWakeLock();
  }
})();`;

export { SYNC_SCRIPT };
