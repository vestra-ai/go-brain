// Go Live in the room (roomPage({ live: true })): the trip's ixigo recipe runs as Go makes them, from Go's live view
// (/v1/live) as the try room relays it. The room is one column, like the App: the trip's computer shows in the chat, in
// the search card's mini browser (the newest picture Go's computer drew, live while the card runs; page.ts), and opens
// big in a sheet. The runs strip sits behind Details, closed until asked for: each run's recipe, speed, data calls and
// times, newest first, with a group of parallel runs as one block whose wall time is set against its sum.
// Like the room's own script, everything here sits inside template literals: no backticks, no dollar-brace and no
// backslashes in it.

export const LIVE_CSS = `
.details { position: fixed; inset: 0; z-index: 8; background: rgba(15, 23, 42, 0.45); display: flex; justify-content: flex-end; }
.details[hidden] { display: none; }
.details-panel { width: min(460px, 100%); height: 100%; background: var(--bg); display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; padding-top: calc(14px + env(safe-area-inset-top)); overflow: hidden; box-shadow: -8px 0 24px rgba(15, 23, 42, 0.12); }
.details-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.details-bar .act { margin-top: 0; font-size: 14px; padding: 8px 12px; }
.live-head { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.live-head .live-state { color: var(--muted); font-size: 13px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #cbd5e1; flex: none; }
.dot.on { background: #22c55e; box-shadow: 0 0 0 3px #dcfce7; }
.speed { font-size: 10px; font-weight: 700; letter-spacing: .05em; border-radius: 6px; padding: 1px 6px; color: #fff; flex: none; }
.speed.fast { background: #16a34a; }
.speed.page { background: #d97706; }
.speed.link { background: #64748b; }
.speed.kept { background: #0891b2; }
.speed.steps { background: #7c3aed; }
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
`;

/** The Details drawer: Go Live's state and the runs strip, closed until the header's Details opens it. */
export const LIVE_DETAILS = `<div class="details" id="details" role="dialog" aria-modal="true" aria-label="Details" hidden>
  <div class="details-panel">
    <div class="details-bar"><b>Details</b><button class="act secondary" id="details-close" type="button">Close</button></div>
    <div class="live-head"><span class="dot" id="live-dot"></span><b>Go Live</b><span class="live-state" id="live-state">Waiting for the trip</span></div>
    <div class="live-note">The searches Go makes on ixigo, on the trip's own computer, newest first. A fast run reads ixigo's own data inside a page that is already open, so nothing on screen moves.</div>
    <div class="strip-head"><b>Runs</b><span id="strip-sum"></span></div>
    <div class="strip" id="strip"></div>
  </div>
</div>
`;

/** Inside the room's script: the socket's handler calls onLive for each { type: 'live' } message. */
export const LIVE_SCRIPT = `
  // Go Live. live.runs: each run by id, a speed that fell and the next one sharing one row (ids, speeds); live.order:
  // top-level rows, newest first; live.groups: rows that went at once. live.last: the newest page the trip's computer
  // drew that Go shows (a tab's or a run's own picture), and when it came: the search card's mini browser shows it.
  var live = { trip: null, state: 'wait', why: '', runs: {}, order: [], groups: {}, screen: { state: null, tabs: {}, order: [] }, last: null };
  var HOLD_MS = 2000;
  var BADGE = { fast: 'FAST', page: 'PAGE', link: 'LINK', kept: 'KEPT', steps: 'GROUP' };

  function liveReset() { live.runs = {}; live.order = []; live.groups = {}; live.screen = { state: null, tabs: {}, order: [] }; }
  function fmtMs(ms) { return ms == null ? '' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
  function clock(at) { var d = new Date(at); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

  function onLive(data) {
    if (data.trip_id !== live.trip) { live.trip = data.trip_id; liveReset(); live.last = null; }
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
    liveFramed();
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
      case 'frames': {
        var f = (e.frames || [])[(e.frames || []).length - 1];
        if (f) drawn(f.jpeg_base64, f.page, (r ? r.startOf[e.run_id] || r.at : Date.now()) + (f.at_ms || 0));
        break;
      }
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
        if (!t) { s.tabs[e.tab_id] = { id: e.tab_id, frame: null, hidden: false, tag: e.tag || null }; s.order.push(e.tab_id); }
        break;
      case 'frame':
        if (!t) { screenEvent({ type: 'tab_open', tab_id: e.tab_id, tag: e.tag }); t = s.tabs[e.tab_id]; }
        if (e.tag) t.tag = e.tag;
        if (!t.hidden) { t.frame = e; drawn(e.jpeg_base64, e.page, Date.parse(e.at)); }
        break;
      case 'hidden': if (t) { t.hidden = e.reason || 'blocked_path'; t.frame = null; if (e.tag) t.tag = e.tag; } break;
      case 'tab_close':
        delete s.tabs[e.tab_id];
        s.order = s.order.filter(function (id) { return id !== e.tab_id; });
        break;
    }
  }

  /**
   * A page the computer drew: the newest one stays as live.last, with when this page got it. Never one Go hides: a hidden
   * tab's pictures never get here.
   */
  function drawn(jpeg, page, at) {
    if (!jpeg) return;
    var when = isNaN(at) ? Date.now() : at;
    if (!live.last || when >= live.last.at) live.last = { jpeg: jpeg, page: page || '/', at: when, got: Date.now() };
  }
  // The search card's mini browser and the sheet read the newest picture through this (page.ts).
  liveShot = function () { return live.last ? { src: 'data:image/jpeg;base64,' + live.last.jpeg, got: live.last.got } : null; };

  /** The open tabs, in the order they opened, at most four. */
  function liveTabs() {
    return live.screen.order.map(function (id) { return live.screen.tabs[id]; }).filter(Boolean).slice(0, 4);
  }

  /** At most 40 runs in the strip; older ones go, with their lookups. */
  function trimLive() {
    while (live.order.length > 40) {
      var gone = live.runs[live.order.pop()];
      if (!gone) continue;
      gone.kids.map(function (k) { return live.runs[k] ? live.runs[k].ids : [k]; }).reduce(function (a, b) { return a.concat(b); }, gone.ids.slice())
        .forEach(function (id) { delete live.runs[id]; });
    }
  }

  function going(r) { return !r.ended || (r.endAt && Date.now() - r.endAt < HOLD_MS); }
  function isGroupRun(r) { return r.speeds[r.speeds.length - 1] === 'steps'; }
  /** The runs going, and those that just ended (held a moment), oldest first. */
  function goingNow() {
    var out = [];
    for (var i = live.order.length - 1; i >= 0; i--) { var r = live.runs[live.order[i]]; if (r && going(r)) out.push(r); }
    return out;
  }
  function tileLabel(r) { return r.lane ? r.lane + ': ' + r.label : r.label; }

  function badges(r) {
    var s = r.speeds;
    return s.map(function (sp, i) { return '<span class="speed ' + (i < s.length - 1 ? 'fell' : esc(sp)) + '">' + esc(BADGE[sp] || sp) + '</span>'; }).join('');
  }

  function outcome(r) {
    if (!r.ended) return '<span class="ms">' + fmtMs(Date.now() - r.at) + '</span>';
    var rows = r.picked ? ' ' + r.picked : r.rows != null ? ' ' + r.rows : '';
    return '<span class="ms">' + fmtMs(r.ms) + '</span>' + (r.ok ? '<span class="ok">✓' + rows + '</span>' : '<span class="bad" title="' + esc(r.why || '') + '">× ' + esc((r.why || 'failed').slice(0, 60)) + '</span>');
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
    var runs = goingNow();
    var steps = runs.filter(function (r) { return !isGroupRun(r); });
    var tabs = runs.length ? liveTabs().length : 0;
    $('live-dot').className = 'dot' + (live.state === 'on' ? ' on' : '');
    $('live-state').textContent = live.state === 'off' ? 'Off. ' + live.why : live.state === 'on'
      ? (tabs > 1 ? tabs + ' pages open, live' : tabs ? 'A page open, live' : steps.length > 1 ? steps.length + ' runs in parallel' : steps.length ? 'Working' : live.screen.state === 'asleep' ? "Live. The trip's computer is asleep" : 'Live')
      : 'Waiting for the trip';
    renderStrip();
  }

  function liveBusy() {
    for (var id in live.runs) if (going(live.runs[id])) return true;
    return false;
  }

  // Details: closed until asked for.
  function showDetails(open) {
    $('details').hidden = !open;
    $('details-open').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  $('details-open').addEventListener('click', function () { showDetails(true); });
  $('details-close').addEventListener('click', function () { showDetails(false); });

  setInterval(function () { if (live.trip && liveBusy()) renderLive(); }, 250);
  renderLive();
`;

/** In the socket's handler, after the room's own message types. */
export const LIVE_HOOK = `      } else if (data.type === 'live') {
        onLive(data);
`;
