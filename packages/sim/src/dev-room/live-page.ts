// Go Live, the room page's second column (roomPage({ live: true })): the trip's ixigo recipe runs as Go makes them, from
// Go's live view (/v1/live) as the try room relays it. On the left the chat as it is; on the right the pages Go's computer
// has open, live (Bash's browser watch, one tile per tab, a grid with more than one), or, with none open, one tile per run
// going at once from each run's own pictures; and the run strip: each run's recipe, speed, data calls and times, newest
// first, with a group of parallel runs as one block whose wall time is set against its sum. A group of steps (how we all
// get there, one search per home city) has a tile across the top saying how many steps are done, its steps below it,
// each named by its city.
// Like the room's own script, everything here sits inside template literals: no backticks, no dollar-brace and no
// backslashes in it.

export const LIVE_CSS = `
.split { display: flex; align-items: stretch; height: 100vh; height: 100dvh; }
.split .app { flex: none; width: 440px; max-width: none; margin: 0; height: 100%; overflow-y: auto; }
.live { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; background: #eef1f6; border-left: 1px solid var(--line); }
.live-head { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.live-head .live-state { color: var(--muted); font-size: 13px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #cbd5e1; flex: none; }
.dot.on { background: #22c55e; box-shadow: 0 0 0 3px #dcfce7; }
.screen { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
.screen.grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; min-width: 0; transition: opacity .3s; }
.tile.ended { opacity: .7; }
.tile-bar { display: flex; gap: 8px; align-items: center; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 12px; min-width: 0; min-height: 34px; }
.tile-bar b { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.tile-bar .url { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.view { aspect-ratio: 16 / 10; background: #e2e8f0; position: relative; overflow: hidden; }
.view img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.view img:not([src]) { display: none; }
.view .hint { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 16px; color: var(--muted); font-size: 13px; }
.view .hint:empty { display: none; }
.view.idle img { filter: grayscale(.6); opacity: .55; }
.view .chip-fast { position: absolute; left: 10px; bottom: 10px; background: #0f172a; color: #fff; border-radius: 8px; padding: 4px 9px; font-size: 12px; }
.view .chip-fast:empty { display: none; }
.fastcard { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--ink); }
.fastcard b { font-size: 14px; }
.fastcard .big { font-size: 40px; font-weight: 700; color: #16a34a; font-variant-numeric: tabular-nums; line-height: 1.1; }
.fastcard code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.speed { font-size: 10px; font-weight: 700; letter-spacing: .05em; border-radius: 6px; padding: 1px 6px; color: #fff; flex: none; }
.speed.fast { background: #16a34a; }
.speed.page { background: #d97706; }
.speed.link { background: #64748b; }
.speed.kept { background: #0891b2; }
.speed.steps { background: #7c3aed; }
.tile.group { grid-column: 1 / -1; }
.group-line { padding: 8px 10px; font-size: 13px; color: var(--muted); }
.speed.live { background: #dc2626; }
.view.hidden { background: #0f172a; }
.view.hidden .hint { color: #cbd5e1; }
.speed.fell { background: #cbd5e1; color: #475569; text-decoration: line-through; }
.ms { font-variant-numeric: tabular-nums; white-space: nowrap; }
.live-note { color: var(--muted); font-size: 12px; }
.strip-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 13px; border-top: 1px solid var(--line); padding-top: 8px; }
.strip-head span { color: var(--muted); font-size: 12px; }
.strip { flex: 1; overflow-y: auto; font-size: 12.5px; min-height: 140px; }
.run { padding: 6px 0; border-bottom: 1px solid var(--line); }
.run-line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.run-line .t { color: var(--muted); font-variant-numeric: tabular-nums; }
.run-line .id { color: var(--muted); font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
.ok { color: #15803d; }
.bad { color: #b91c1c; }
.calls { margin: 3px 0 0 18px; color: #334155; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
.calls div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.child { margin: 4px 0 0 18px; }
.group { border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; margin: 6px 0; background: var(--panel); }
.group-head { font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.group .run:last-child { border-bottom: 0; }
.wf { position: relative; height: 8px; background: #eef2f7; border-radius: 4px; margin: 4px 0 0; }
.wf i { position: absolute; top: 0; bottom: 0; border-radius: 4px; min-width: 3px; }
@media (max-width: 1099px) {
  .split { display: block; height: auto; }
  .split .app { width: auto; max-width: var(--column); margin: 0 auto; height: auto; overflow: visible; }
  .live { height: auto; border-left: 0; border-top: 1px solid var(--line); }
}
`;

export const LIVE_ASIDE = `<aside class="live" id="live" aria-label="Go Live">
  <div class="live-head"><span class="dot" id="live-dot"></span><b>Go Live</b><span class="live-state" id="live-state">Waiting for the trip</span></div>
  <div class="screen" id="screen"></div>
  <div class="live-note">Pages show live as Go's computer opens them, never a payment or sign-in page. A fast run reads ixigo's own data inside a page that is already open, so nothing on screen moves: the strip shows it.</div>
  <div class="strip-head"><b>Runs</b><span id="strip-sum"></span></div>
  <div class="strip" id="strip"></div>
</aside>`;

/** Inside the room's script: the socket's handler calls onLive for each { type: 'live' } message. */
export const LIVE_SCRIPT = `
  // Go Live. live.runs: each run by id, a speed that fell and the next one sharing one row (ids, speeds); live.order:
  // top-level rows, newest first; live.groups: rows that went at once.
  var live = { trip: null, state: 'wait', why: '', runs: {}, order: [], groups: {}, frames: {}, screen: { state: null, tabs: {}, order: [] } };
  var HOLD_MS = 2000;
  var PLAY_MS = 2500;
  var BADGE = { fast: 'FAST', page: 'PAGE', link: 'LINK', kept: 'KEPT', steps: 'GROUP' };

  function liveReset() { live.runs = {}; live.order = []; live.groups = {}; live.frames = {}; live.screen = { state: null, tabs: {}, order: [] }; }
  function fmtMs(ms) { return ms == null ? '' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
  function clock(at) { var d = new Date(at); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

  function onLive(data) {
    if (data.trip_id !== live.trip) { live.trip = data.trip_id; liveReset(); }
    var m = data.msg || {};
    if (m.type === 'off') { live.state = 'off'; live.why = m.why || ''; }
    else if (m.type === 'hello') {
      live.state = 'on';
      liveReset();
      for (var i = 0; i < (m.events || []).length; i++) liveEvent(m.events[i], true);
      for (var k = 0; k < (m.screen || []).length; k++) screenEvent(m.screen[k]);
    } else if (m.type === 'run' && m.event) { live.state = 'on'; liveEvent(m.event, false); }
    else if (m.type === 'screen' && m.event) { live.state = 'on'; screenEvent(m.event); }
    renderLive();
  }

  function liveEvent(e, old) {
    var r = e.run_id ? live.runs[e.run_id] : null;
    var lineAt = function (ms) { return r ? (r.startOf[e.run_id] || r.at) + ms : ms; };
    switch (e.type) {
      case 'run_start':
        // A speed that fell and the one after it are one row: FAST struck through, then PAGE.
        if (e.fell_from && live.runs[e.fell_from]) {
          r = live.runs[e.fell_from];
          r.ids.push(e.run_id); r.speeds.push(e.speed); r.speedOf[e.run_id] = e.speed; r.startOf[e.run_id] = Date.parse(e.at);
          r.ended = false; r.endAt = 0;
          live.runs[e.run_id] = r;
          break;
        }
        r = { id: e.run_id, ids: [e.run_id], recipe: e.recipe_id, label: e.label, parent: e.parent || null, stepOf: e.step_of || null, lane: e.lane || null, group: e.group_id, at: Date.parse(e.at),
          speeds: [e.speed], speedOf: {}, startOf: {}, msBefore: 0, lines: [], kids: [], ended: false, endAt: 0 };
        r.speedOf[e.run_id] = e.speed; r.startOf[e.run_id] = r.at;
        live.runs[r.id] = r;
        if (r.parent && live.runs[r.parent]) { live.runs[r.parent].kids.push(r.id); break; }
        live.order.unshift(r.id);
        if (!live.groups[r.group]) live.groups[r.group] = { id: r.group, runs: [], at: r.at, ended: false };
        live.groups[r.group].runs.push(r.id);
        trimLive();
        break;
      case 'call':
        if (r) r.lines.push({ at: lineAt(e.at_ms), text: (e.method ? e.method + ' ' : '') + e.path + '  ' + e.status + '  ' + (e.ms != null ? fmtMs(e.ms) : '+' + fmtMs(lineAt(e.at_ms) - r.at)), fast: r.speedOf[e.run_id] === 'fast', ms: e.ms });
        break;
      case 'step': if (r) r.lines.push({ at: lineAt(e.at_ms), text: e.text + '  +' + fmtMs(lineAt(e.at_ms) - r.at) }); break;
      case 'run_end':
        if (!r) break;
        if (e.fell_to) {
          r.msBefore += e.ms;
          r.lines.push({ at: lineAt(e.ms), text: r.speedOf[e.run_id] + ' fell to ' + e.fell_to + (e.why ? ': ' + e.why : '') });
          break;
        }
        r.ended = true; r.ok = e.ok; r.ms = r.msBefore + e.ms; r.rows = e.rows; r.why = e.why; r.picked = e.picked;
        r.endAt = old ? 0 : Date.now();
        break;
      case 'frames': live.frames[e.run_id] = { list: e.frames || [], got: old ? 0 : Date.now() }; break;
      case 'group_end':
        if (live.groups[e.group_id]) { live.groups[e.group_id].ended = true; live.groups[e.group_id].wall = e.wall_ms; live.groups[e.group_id].sum = e.sum_ms; }
        break;
    }
  }

  /** The trip computer's screen, from Bash's browser watch: each open tab and its newest picture, or that it is hidden. */
  function screenEvent(e) {
    var s = live.screen;
    var t = e.tab_id ? s.tabs[e.tab_id] : null;
    switch (e.type) {
      case 'state': s.state = e.state; break;
      case 'tab_open':
        if (!t) { s.tabs[e.tab_id] = { id: e.tab_id, frame: null, hidden: false }; s.order.push(e.tab_id); }
        break;
      case 'frame':
        if (!t) { screenEvent({ type: 'tab_open', tab_id: e.tab_id }); t = s.tabs[e.tab_id]; }
        if (!t.hidden) t.frame = e;
        break;
      case 'hidden': if (t) { t.hidden = true; t.frame = null; } break;
      case 'tab_close':
        delete s.tabs[e.tab_id];
        s.order = s.order.filter(function (id) { return id !== e.tab_id; });
        break;
    }
  }

  /** The open tabs, in the order they opened, at most four. */
  function liveTabs() {
    return live.screen.order.map(function (id) { return live.screen.tabs[id]; }).filter(Boolean).slice(0, 4);
  }

  /** At most 40 runs in the strip; older ones go, with their lookups and pictures. */
  function trimLive() {
    while (live.order.length > 40) {
      var gone = live.runs[live.order.pop()];
      if (!gone) continue;
      gone.kids.map(function (k) { return live.runs[k] ? live.runs[k].ids : [k]; }).reduce(function (a, b) { return a.concat(b); }, gone.ids.slice())
        .forEach(function (id) { delete live.runs[id]; delete live.frames[id]; });
    }
  }

  function topOf(r) { return r.parent && live.runs[r.parent] ? live.runs[r.parent] : r; }
  function going(r) { return !r.ended || (r.endAt && Date.now() - r.endAt < HOLD_MS); }

  function isGroupRun(r) { return r.speeds[r.speeds.length - 1] === 'steps'; }

  /**
   * The runs on screen: those going, and those that just ended (held a moment), oldest first, at most four. A group of
   * steps (how we all get there) shows as its own tile across the top, then its steps, at most four; its link-only
   * steps (flights) have no page and end at once, so they take no tile.
   */
  function tilesNow() {
    var out = [];
    for (var i = live.order.length - 1; i >= 0; i--) { var r = live.runs[live.order[i]]; if (r && going(r)) out.push(r); }
    var groups = out.filter(isGroupRun);
    if (!groups.length) return out.slice(-4);
    var steps = out.filter(function (x) { return !isGroupRun(x) && x.speeds[x.speeds.length - 1] !== 'link'; });
    return groups.slice(-1).concat(steps.slice(0, 4));
  }

  /** A group's own tile: how many of its steps are done, and once it ends, its wall time against the sum of its steps. */
  function groupLine(r) {
    var steps = live.order.map(function (id) { return live.runs[id]; }).filter(function (x) { return x && x.stepOf === r.id; });
    var done = steps.filter(function (x) { return x.ended; }).length;
    var g = live.groups[r.group];
    var timing = g && g.ended ? ', wall ' + fmtMs(g.wall) + ' against ' + fmtMs(g.sum) + ' one after another' : '';
    return steps.length + ' steps at once, ' + done + ' done' + timing;
  }

  function tileLabel(r) { return r.lane ? r.lane + ': ' + r.label : r.label; }

  /** The newest pictures of a run or its lookups, played back over at most PLAY_MS as they arrive; the last once played. */
  function pictureOf(r) {
    var best = null;
    r.kids.concat(r.ids).forEach(function (id) { var f = live.frames[id]; if (f && f.list.length && (!best || f.got >= best.got)) best = f; });
    if (!best) return null;
    var list = best.list;
    if (!best.got) return list[list.length - 1];
    var first = list[0].at_ms;
    var span = list[list.length - 1].at_ms - first;
    var k = span > PLAY_MS ? PLAY_MS / span : 1;
    var elapsed = Date.now() - best.got;
    var shown = list[0];
    for (var i = 0; i < list.length; i++) if ((list[i].at_ms - first) * k <= elapsed) shown = list[i];
    return shown;
  }

  function lastWithPictures() {
    for (var i = 0; i < live.order.length; i++) { var r = live.runs[live.order[i]]; if (r && pictureOf(r)) return r; }
    return null;
  }

  function badges(r) {
    var s = r.speeds;
    return s.map(function (sp, i) { return '<span class="speed ' + (i < s.length - 1 ? 'fell' : esc(sp)) + '">' + esc(BADGE[sp] || sp) + '</span>'; }).join('');
  }

  function outcome(r) {
    if (!r.ended) return '<span class="ms">' + fmtMs(Date.now() - r.at) + '</span>';
    var rows = r.picked ? ' ' + r.picked : r.rows != null ? ' ' + r.rows : '';
    return '<span class="ms">' + fmtMs(r.ms) + '</span>' + (r.ok ? '<span class="ok">✓' + rows + '</span>' : '<span class="bad" title="' + esc(r.why || '') + '">× ' + esc((r.why || 'failed').slice(0, 60)) + '</span>');
  }

  function emptyLine() {
    if (live.state === 'off') return 'Live view is off. ' + live.why;
    if (!live.trip) return 'Say something to start the trip. Its searches show here.';
    return "Pages Go opens on the trip's computer show here.";
  }

  /** The tabs open on the trip's computer, live: the newest picture of each, or a dark tile for one Go never shows. */
  function renderTabs(screen, tabs) {
    var key = 'tabs:' + tabs.map(function (t) { return t.id; }).join(',');
    if (screen.getAttribute('data-key') !== key) {
      screen.setAttribute('data-key', key);
      screen.className = 'screen' + (tabs.length > 1 ? ' grid' : '');
      screen.innerHTML = tabs.map(function (t) { return '<div class="tile" data-tab="' + esc(t.id) + '"><div class="tile-bar"></div><div class="view"><img alt=""><span class="hint"></span></div></div>'; }).join('');
    }
    var els = screen.querySelectorAll('.tile');
    for (var i = 0; i < els.length; i++) {
      var t = live.screen.tabs[els[i].getAttribute('data-tab')];
      if (!t) continue;
      els[i].className = 'tile';
      els[i].querySelector('.tile-bar').innerHTML = '<span class="speed live">LIVE</span><span class="url">' + esc(t.hidden ? 'Not shown' : t.frame ? 'ixigo.com' + t.frame.page : 'Opening') + '</span>';
      var view = els[i].querySelector('.view');
      view.className = 'view' + (t.hidden ? ' hidden' : '');
      var img = view.querySelector('img');
      var src = t.frame ? 'data:image/jpeg;base64,' + t.frame.jpeg_base64 : '';
      if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
      if (!src && img.hasAttribute('src')) img.removeAttribute('src');
      view.querySelector('.hint').textContent = t.hidden ? 'A page Go never shows (payment or sign-in)' : src ? '' : "Opening the page on the trip's computer";
    }
  }

  function renderScreen() {
    var screen = $('screen');
    var tabs = liveTabs();
    if (tabs.length) { renderTabs(screen, tabs); return; }
    var tiles = tilesNow();
    var idle = false;
    if (!tiles.length) { var last = lastWithPictures(); if (last) { tiles = [last]; idle = true; } }
    var key = tiles.map(function (r) { return r.id; }).join(',') + (idle ? ':idle' : '');
    if (screen.getAttribute('data-key') !== key) {
      screen.setAttribute('data-key', key);
      screen.className = 'screen' + (tiles.length > 1 ? ' grid' : '');
      screen.innerHTML = tiles.length
        ? tiles.map(function (r) {
          if (isGroupRun(r)) return '<div class="tile group" data-run="' + esc(r.id) + '"><div class="tile-bar"></div><div class="group-line"></div></div>';
          return '<div class="tile" data-run="' + esc(r.id) + '"><div class="tile-bar"></div><div class="view"><img alt=""><span class="hint"></span><span class="chip-fast"></span></div></div>';
        }).join('')
        : '<div class="tile"><div class="view"><span class="hint"></span></div></div>';
    }
    if (!tiles.length) { screen.querySelector('.hint').textContent = emptyLine(); return; }
    var els = screen.querySelectorAll('.tile');
    for (var i = 0; i < els.length; i++) {
      var r = live.runs[els[i].getAttribute('data-run')];
      if (!r) continue;
      if (isGroupRun(r)) {
        els[i].className = 'tile group' + (r.ended ? ' ended' : '');
        els[i].querySelector('.tile-bar').innerHTML = '<b>' + esc(r.label) + '</b>' + badges(r) + outcome(r);
        els[i].querySelector('.group-line').textContent = groupLine(r);
        continue;
      }
      var pic = pictureOf(r);
      els[i].className = 'tile' + (r.ended ? ' ended' : '');
      els[i].querySelector('.tile-bar').innerHTML = '<b>' + esc(tileLabel(r)) + '</b>' + badges(r) + outcome(r) + '<span class="url">' + esc(pic ? 'ixigo.com' + pic.page : r.recipe) + '</span>';
      var view = els[i].querySelector('.view');
      view.className = 'view' + (idle ? ' idle' : '');
      var img = view.querySelector('img');
      var src = pic ? 'data:image/jpeg;base64,' + pic.jpeg_base64 : '';
      if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
      if (!src && img.hasAttribute('src')) img.removeAttribute('src');
      var fast = r.speeds[r.speeds.length - 1] === 'fast';
      var call = null;
      for (var j = 0; j < r.lines.length; j++) if (r.lines[j].fast) call = r.lines[j];
      // A fast run moves nothing on screen: over a picture, a chip says so; with none, the call itself fills the tile.
      view.querySelector('.chip-fast').textContent = fast && pic ? 'In-page data call' + (call && call.ms != null ? ', ' + fmtMs(call.ms) : '') + '. No page load.' : '';
      var hint = view.querySelector('.hint');
      if (fast && !pic) {
        hint.innerHTML = '<div class="fastcard"><b>In-page data call, no page load</b><span class="big">' + esc(call && call.ms != null ? fmtMs(call.ms) : fmtMs(Date.now() - r.at)) + '</span>' +
          (call ? '<code>' + esc(call.text.split('  ')[0]) + '</code>' : '<code>inside the open ixigo tab</code>') + '</div>';
      } else {
        hint.textContent = pic || idle ? '' : r.ended ? (r.ok ? 'Done' : 'Stopped') : "Opening the page on the trip's computer";
      }
    }
  }

  function runHtml(r, child, extra) {
    var kids = r.kids.map(function (id) { return live.runs[id] ? runHtml(live.runs[id], true, '') : ''; }).join('');
    var lines = r.lines.slice().sort(function (a, b) { return a.at - b.at; }).slice(-8).map(function (l) { return '<div>' + esc(l.text) + '</div>'; }).join('');
    return '<div class="' + (child ? 'child' : 'run') + '"><div class="run-line">' + (child ? '' : '<span class="t">' + clock(r.at) + '</span>') + '<b>' + esc(tileLabel(r)) + '</b><span class="id">' + esc(r.recipe) + '</span>' + badges(r) + outcome(r) + '</div>' +
      (extra || '') + (lines ? '<div class="calls">' + lines + '</div>' : '') + kids + '</div>';
  }

  function waterfall(g, r) {
    var end = g.ended ? g.at + g.wall : Date.now();
    var span = Math.max(1, end - g.at);
    var left = Math.max(0, Math.min(100, ((r.at - g.at) / span) * 100));
    var width = Math.max(0.5, Math.min(100 - left, (((r.ended ? r.ms : Date.now() - r.at) || 0) / span) * 100));
    var sp = r.speeds[r.speeds.length - 1];
    var colour = sp === 'fast' ? '#16a34a' : sp === 'page' ? '#d97706' : '#64748b';
    return '<div class="wf"><i style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%;background:' + colour + '"></i></div>';
  }

  function renderStrip() {
    var seen = {};
    var html = '';
    for (var i = 0; i < live.order.length; i++) {
      var r = live.runs[live.order[i]];
      if (!r || seen[r.group]) continue;
      seen[r.group] = true;
      var g = live.groups[r.group];
      var runs = (g ? g.runs : [r.id]).map(function (id) { return live.runs[id]; }).filter(Boolean);
      if (runs.length < 2) { html += runHtml(r, false, ''); continue; }
      var head = runs.length + ' in parallel, ' + (g.ended ? 'wall ' + fmtMs(g.wall) + ' (sum ' + fmtMs(g.sum) + ')' : 'running ' + fmtMs(Date.now() - g.at));
      html += '<div class="group"><div class="group-head">' + esc(head) + '</div>' + runs.map(function (x) { return runHtml(x, false, waterfall(g, x)); }).join('') + '</div>';
    }
    $('strip').innerHTML = html || '<div class="muted">No runs yet.</div>';
    var tally = {};
    var done = live.order.map(function (id) { return live.runs[id]; }).filter(function (x) { return x && x.ended && x.ok; }).slice(0, 10);
    done.forEach(function (x) { var sp = x.speeds[x.speeds.length - 1]; var t = tally[sp] || (tally[sp] = { n: 0, ms: 0 }); t.n += 1; t.ms += x.ms; });
    $('strip-sum').textContent = done.length ? 'Last ' + done.length + ': ' + Object.keys(tally).map(function (k) { return tally[k].n + ' ' + k + ' avg ' + fmtMs(tally[k].ms / tally[k].n); }).join(', ') : '';
  }

  function renderLive() {
    var tiles = tilesNow().filter(function (r) { return !isGroupRun(r); });
    $('live-dot').className = 'dot' + (live.state === 'on' ? ' on' : '');
    var tabs = liveTabs().length;
    $('live-state').textContent = live.state === 'off' ? 'Off' : live.state === 'on'
      ? (tabs > 1 ? tabs + ' pages open, live' : tabs ? 'A page open, live' : tiles.length > 1 ? tiles.length + ' runs in parallel' : tiles.length ? 'Working' : live.screen.state === 'asleep' ? "Live. The trip's computer is asleep" : 'Live')
      : 'Waiting for the trip';
    renderScreen();
    renderStrip();
  }

  function liveBusy() {
    var now = Date.now();
    for (var id in live.runs) if (going(live.runs[id])) return true;
    for (var f in live.frames) if (live.frames[f].got && now - live.frames[f].got < PLAY_MS + 500) return true;
    return false;
  }

  setInterval(function () { if (live.trip && liveBusy()) renderLive(); }, 250);
  renderLive();
`;

/** In the socket's handler, after the room's own message types. */
export const LIVE_HOOK = `      } else if (data.type === 'live') {
        onLive(data);
`;
