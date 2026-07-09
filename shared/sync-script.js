// Shared bookmarklet payload, served at /sync.js by both deployment targets
// (the Cloudflare Worker in worker/ and the self-hosted Docker server in server/).
// __ORIGIN__, __UID__, and __KEY__ are substituted per-request by whichever server is serving it.
// __KEY__ is the deployer's own SYNC_KEY secret (if configured) — sent back on writes so the
// ingest endpoints can reject requests that didn't come from this served script.
// Runs entirely via same-origin fetch()+DOMParser from a theshow.com tab — no extension needed.
const SYNC_SCRIPT = `(async function() {
  var INGEST_ORIGIN = '__ORIGIN__';
  var UID = '__UID__';
  var SYNC_KEY = '__KEY__';
  var UID_QS = UID ? ('?uid=' + encodeURIComponent(UID)) : '';
  var BATCH = 4;

  function log(msg) { console.log('[MLB26 Sync]', msg); }
  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function fetchT(url, opts, ms) {
    ms = ms || 20000;
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, ms);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(function() { clearTimeout(t); });
  }

  function parseMissions(doc) {
    return Array.prototype.slice.call(doc.querySelectorAll('meter')).map(function(m) {
      var block = m.closest('.accordion-block');
      var label = block && block.querySelector('.accordion-toggle-label');
      var value = parseFloat(m.value) || 0;
      var max = parseFloat(m.max) || 1;
      return { name: label ? label.textContent.trim() : '?', value: value, max: max, done: value >= max };
    });
  }

  async function scrapeTeam(league, teamId) {
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

  async function scrapeLeague(league, startId, endId) {
    var teams = {};
    var teamIds = [];
    for (var i = startId; i <= endId; i++) teamIds.push(i);
    for (var b = 0; b < teamIds.length; b += BATCH) {
      var batch = teamIds.slice(b, b + BATCH);
      log(league.toUpperCase() + ' teams ' + Math.min(b + BATCH, teamIds.length) + '/' + teamIds.length + '...');
      var results = await Promise.allSettled(batch.map(function(teamId) { return scrapeTeam(league, teamId); }));
      results.forEach(function(r, idx) {
        var teamId = batch[idx];
        if (r.status === 'fulfilled' && r.value) {
          teams[league + '_' + teamId] = Object.assign({ league: league, teamId: teamId }, r.value);
        }
      });
      await sleep(600);
    }
    return teams;
  }

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

  async function scrapeGeneralPrograms() {
    var result = {};
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

    for (var pi = 0; pi < toScrape.length; pi++) {
      var prog = toScrape[pi];
      log('Program ' + (pi + 1) + '/' + toScrape.length + ': ' + prog.name + '...');
      try {
        var rp = await fetchT(prog.path, { credentials: 'include' });
        if (!rp.ok) continue;
        var htmlp = await rp.text();
        var docp = new DOMParser().parseFromString(htmlp, 'text/html');
        var detailp = scrapeMissionsFromDoc(docp, prog.name);
        if (detailp.missions.length) {
          var key3 = prog.path.replace(/[^a-z0-9]/gi, '_');
          result[key3] = { name: detailp.title || prog.name, path: prog.path, pct: (prog.pct != null ? prog.pct : detailp.pct), missions: detailp.missions };
        }
      } catch (e) {}
      await sleep(300);
    }

    return result;
  }

  try {
    if (location.hostname.indexOf('theshow.com') === -1) {
      alert('MLB26 Sync: run this bookmarklet from a mlb26.theshow.com tab, not from ' + location.hostname + '.');
      return;
    }

    log('Starting sync...');
    var alTeams = await scrapeLeague('al', 0, 14);
    var nlTeams = await scrapeLeague('nl', 15, 29);
    var allTeams = Object.assign({}, alTeams, nlTeams);
    log('Scraped ' + Object.keys(allTeams).length + ' teams.');

    if (Object.keys(allTeams).length === 0) {
      alert('MLB26 Sync: no team data found. Make sure you are logged in to mlb26.theshow.com, then try again. Your existing saved data was NOT changed.');
      return;
    }

    log('Saving...');
    await fetch(INGEST_ORIGIN + '/ingest-programs' + UID_QS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
      body: JSON.stringify({ teams: allTeams, savedAt: new Date().toISOString() })
    });

    log('Scanning general programs...');
    var generalPrograms = await scrapeGeneralPrograms();
    log('Scraped ' + Object.keys(generalPrograms).length + ' general programs.');

    if (Object.keys(generalPrograms).length > 0) {
      log('Saving...');
      await fetch(INGEST_ORIGIN + '/ingest-general-programs' + UID_QS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
        body: JSON.stringify({ programs: generalPrograms, savedAt: new Date().toISOString() })
      });
    }

    log('Done!');
    alert('MLB26 Sync complete: ' + Object.keys(allTeams).length + ' teams, ' + Object.keys(generalPrograms).length + ' other programs. Refresh the tracker to see updates.');
  } catch (e) {
    console.error('[MLB26 Sync] Error:', e);
    alert('MLB26 Sync failed: ' + e.message + ' — your existing saved data was not changed.');
  }
})();`;

export { SYNC_SCRIPT };
