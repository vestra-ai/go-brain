// A login on Go's computer, in the chat (roomPage({ live: true, watchOrigin })). The ixigo login card, for the person
// you are playing, shows a small browser tile: "Opening ixigo's login on Go's computer…" while Go brings the login page in
// front (about 2 s, or 9 to 12 s when the computer wakes), then "Log in to ixigo". A tap opens it big in the sheet
// (browser.ts) with Go's screen in control, where they type their own number and code, and the card's I'm logged in and
// Not now under it. Everyone else's card says who is logging in and never shows the page. The screen is the card's Watch
// answer, which the room sends to the tapping socket only: the page taps Watch itself, once per hand-off, as soon as
// Watch comes, and frames the answer when it is on Bash's session page (watchOrigin), so the sheet opens on a loaded page.
// Its picture takes 5 to 15 s to come after the page loads: "Opening ixigo's login…" stays over the frame until Bash's
// embed says the picture is live (a postMessage), or, from an embed that says nothing, for 5 s.
// When the hand-off ends (logged in, Not now, out of time), the sheet closes and the card says so.
// Like the room's own script, everything here sits inside template literals: no backticks, no dollar-brace and no
// backslashes in it.

/** The card actions that answer with Go's screen: a working card's Watch, and the ixigo login card's. */
export const WATCH_ACTIONS: readonly string[] = ['watch', 'ixigo_watch'];
/** The action only the ixigo login card in its logging-in state carries: with no Watch yet, the login is opening. */
export const LOGGING_IN_ACTIONS: readonly string[] = ['ixigo_logged_in'];

export const LOGIN_CSS = `
/* The login card's tile: a small browser drawn as ixigo's login box (Go never pictures a sign-in page). */
.login-face { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 22px 16px; aspect-ratio: 16 / 9; background: #fff; text-align: center; }
.login-face b { font-size: 16px; }
.login-field { width: min(260px, 90%); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; color: var(--muted); font-size: 14px; text-align: left; background: var(--bg); }
.login-cta { color: var(--go-ink); font-weight: 650; font-size: 14px; }
.login-note { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 12px; padding: 8px 12px; color: var(--warn); font-size: 14px; margin-top: 8px; }
.login-note[hidden] { display: none; }
/* While the login opens: a thin bar that drifts, calm; still for anyone who asks for less motion. */
.login-progress { position: relative; display: block; width: 160px; height: 3px; border-radius: 999px; background: #e0f2fe; overflow: hidden; }
.login-progress[hidden] { display: none; }
.login-progress i { position: absolute; top: 0; bottom: 0; left: -40%; width: 40%; border-radius: 999px; background: var(--go); animation: login-drift 1.6s ease-in-out infinite; }
@keyframes login-drift { from { left: -40%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .login-progress i { animation: none; left: 30%; } }
/* The sheet's login mode: Go's screen in control, filling the sheet, with the card's own buttons at the foot. */
.sheet-login { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
.sheet-login[hidden] { display: none; }
.sheet-login .login-note { margin-top: 0; }
.login-line { color: var(--muted); font-size: 13px; }
/* The frame and, over it until its picture is live, the opening state: the frame keeps loading underneath. */
.login-stage { flex: 1; min-height: 0; position: relative; }
.login-frame { position: absolute; inset: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.login-frame[hidden] { display: none; }
.login-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.login-wait { position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 28px 16px; color: var(--muted); font-size: 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.login-wait[hidden] { display: none; }
.sheet-login .actions { margin-top: 0; }
.sheet-login .actions .act { flex: 1; }
`;

/** The sheet's login mode (browser.ts): the line, Go's heads-up, the frame or its wait, and the card's buttons. */
export const LOGIN_SHEET = `    <div class="sheet-login" id="sheet-login" hidden>
      <div class="login-line" id="login-line"></div>
      <div class="login-note" id="login-note" role="status" hidden></div>
      <div class="login-stage">
        <div class="login-frame" id="login-frame"></div>
        <div class="login-wait" id="login-wait" hidden><span id="login-why"></span><span class="login-progress" id="login-progress" aria-hidden="true"><i></i></span><button class="act primary" id="login-again" type="button" hidden>Open the login again</button></div>
      </div>
      <div class="actions" id="login-acts"></div>
    </div>
`;

/** Inside the room's script, after Go Live's: render() calls syncLogin, a tap's answer goes to watchHere first. */
export const LOGIN_SCRIPT = `
  // A login hand-off on Go's screen. login.asked: when this tab tapped Watch for each hand-off (card and person);
  // login.sessions: each one's screen as Watch answered it, or why there is none; login.framed: the hand-off whose screen
  // is in the sheet's frame, kept while the sheet is closed or you play someone else, so a half-typed number stays.
  var WATCH = ${JSON.stringify(WATCH_ACTIONS)};
  var LOGGING_IN = ${JSON.stringify(LOGGING_IN_ACTIONS)};
  var WATCH_ORIGIN = $('sheet').getAttribute('data-watch-origin') || '';
  var WATCH_WAIT_MS = 10000;
  // An embed that says nothing of its picture this long (one from before it could) is shown as it is, and a picture still
  // connecting this long is shown too: the embed's own state says the rest.
  var EMBED_QUIET_MS = 5000;
  var EMBED_CONNECTING_MS = 30000;
  var IXIGO_LINE = 'Type your number and the code. They go to ixigo only. Go never sees them.';
  var OPENING = "Opening ixigo's login on Go's computer…";
  // login.picture: what Bash's embed in the frame last said of its picture ('' for nothing yet, connecting, live, error),
  // and login.mountedAt when that frame was put up.
  var login = { asked: {}, sessions: {}, framed: '', picture: '', mountedAt: 0 };

  function watchOf(c) {
    var acts = c.actions || [];
    for (var i = 0; i < acts.length; i++) if (WATCH.indexOf(acts[i].action_id) >= 0) return acts[i];
    return null;
  }
  /** A card that hands Go's screen to someone: it is for them and carries Watch; a working card only while it needs them. */
  function isHandoff(c) {
    return !!(c && c.for_person_ids && c.for_person_ids.length && (c.kind !== 'working' || c.state === 'needs_you') && watchOf(c));
  }
  /** The login card for someone, in its logging-in state with no Watch yet: Go is bringing the login page in front. */
  function isOpening(c) {
    return !!(c && c.kind === 'notice' && c.for_person_ids && c.for_person_ids.length && !watchOf(c) &&
      (c.actions || []).some(function (a) { return LOGGING_IN.indexOf(a.action_id) >= 0; }));
  }
  function cards(keep) {
    var out = [];
    for (var i = 0; i < state.messages.length; i++) {
      var c = state.messages[i].deleted ? null : state.messages[i].card;
      if (keep(c)) out.push(c);
    }
    return out;
  }
  function handoffs() { return cards(isHandoff); }
  function keyOf(c, who) { return c.card_id + ' ' + who; }
  /** The newest hand-off for this person. With opening, a login still opening counts too. */
  function handoffFor(who, opening) {
    var list = cards(function (c) { return isHandoff(c) || (opening && isOpening(c)); });
    for (var i = list.length - 1; i >= 0; i--) if (list[i].for_person_ids.indexOf(who) >= 0) return list[i];
    return null;
  }
  function stillOpen(key) {
    return handoffs().some(function (c) { return c.for_person_ids.some(function (p) { return keyOf(c, p) === key; }); });
  }
  /** Bash's session page, the only page the sheet frames. */
  function frameable(u) {
    try {
      return WATCH_ORIGIN && safeUrl(u) && new URL(u).origin === WATCH_ORIGIN ? u : '';
    } catch (e) {
      return '';
    }
  }
  function tapWatch(c, who) {
    login.asked[keyOf(c, who)] = Date.now();
    delete login.sessions[keyOf(c, who)];
    tapCard(c.card_id, watchOf(c).action_id, '', who);
  }
  /** The card's own buttons for you, but Watch: the page taps that itself. */
  function loginButtons(c) {
    return (c.actions || []).filter(function (a) { return WATCH.indexOf(a.action_id) < 0 && visible(a); })
      .map(function (a) { return goButton(c, a, ''); }).join('');
  }

  // A card that hands Go's screen to the person you play: its sheet is their screen, in control, and its Watch opens it
  // (the page tapped Watch already).
  handoffMine = function (cardId) {
    var c = WATCH_ORIGIN ? handoffFor(me, true) : null;
    return !!c && c.card_id === cardId;
  };
  watchOpensSheet = function (cardId, actionId) { return WATCH.indexOf(actionId) >= 0 && handoffMine(cardId); };

  // The ixigo login card while someone logs in: for you, its tile; for anyone else, who is logging in. Go turns it to a
  // heads-up when I'm logged in found no login yet: its words show on the card and in the sheet. Null for other cards.
  loginPart = function (c) {
    if (!WATCH_ORIGIN || c.kind !== 'notice' || !(isHandoff(c) || isOpening(c))) return null;
    var buttons = loginButtons(c);
    var acts = buttons ? '<div class="actions">' + buttons + '</div>' : '';
    if (c.for_person_ids.indexOf(me) < 0) {
      return '<span class="tag">Logging in</span><h3>' + esc(c.title) + '</h3><div>' + esc(nameOf(c.for_person_ids[0])) + ' is logging in to ixigo</div>' + acts;
    }
    var note = c.tone === 'heads_up' ? '<div class="login-note" role="status">' + esc(c.body || '') + '</div>' : '';
    var face = watchOf(c)
      ? '<b>Log in to ixigo</b><span class="login-field">Mobile number</span><span class="login-cta">Tap to log in</span>'
      : '<b>' + esc(OPENING) + '</b><span class="login-progress" aria-hidden="true"><i></i></span>';
    return '<span class="tag warn">Needs you</span><h3>' + esc(c.title) + '</h3>' + note +
      '<button class="mini login-tile" type="button" data-browse="' + esc(c.card_id) + '"><span class="mini-bar"><i></i><i></i><i></i><span class="mini-host">ixigo.com</span></span>' +
      '<span class="login-face">' + face + '</span></button><div class="meta">' + esc(IXIGO_LINE) + '</div>' + acts;
  };

  // A Watch answer for a hand-off: its screen goes in the sheet's frame. Anything else opens as it always did.
  watchHere = function (data) {
    if (!state || !WATCH_ORIGIN || WATCH.indexOf(data.actionId) < 0) return false;
    var c = handoffFor(data.personId);
    if (!c || c.card_id !== data.cardId) return false;
    var key = keyOf(c, data.personId);
    var r = data.result || {};
    var url = r.result === 'open' ? frameable(r.url) : '';
    if (!url) {
      login.sessions[key] = { why: 'refused' };
      renderSheet();
      return false;
    }
    var ends = Date.parse(r.expires_at) || Date.now() + 15 * 60000;
    login.sessions[key] = { url: url, ends: ends };
    setTimeout(function () { syncLogin(); renderSheet(); }, Math.max(0, ends - Date.now()) + 50);
    syncLogin();
    renderSheet();
    return true;
  };

  /** After each render: Watch tapped once when it comes, and the frame holding the session of the hand-off it is for. */
  function syncLogin() {
    if (!state) return;
    var mine = WATCH_ORIGIN ? handoffFor(me, true) : null;
    // Null while the login is still opening on Go's computer: nothing to tap yet.
    var watch = mine ? watchOf(mine) : null;
    var now = Date.now();
    for (var k in login.sessions) if (login.sessions[k].url && now >= login.sessions[k].ends) login.sessions[k] = { why: 'ended' };
    // The frame keeps its screen while its hand-off is open and its session good, whoever you are playing now.
    if (login.framed && (!login.sessions[login.framed] || !login.sessions[login.framed].url || !stillOpen(login.framed))) {
      $('login-frame').innerHTML = '';
      login.framed = '';
    }
    var key = mine ? keyOf(mine, me) : '';
    if (watch && !login.asked[key]) tapWatch(mine, me);
    var s = watch ? login.sessions[key] : null;
    if (s && s.url && login.framed !== key) {
      $('login-frame').innerHTML = '<iframe title="Go&#39;s computer" src="' + esc(s.url) + '" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe>';
      login.framed = key;
      login.picture = '';
      login.mountedAt = Date.now();
      setTimeout(renderSheet, EMBED_QUIET_MS + 50);
      setTimeout(renderSheet, EMBED_CONNECTING_MS + 50);
    }
  }

  /** Whether the frame's picture is up: the embed says live, or it has had its time to say anything. */
  function pictureUp() {
    var waited = Date.now() - login.mountedAt;
    if (login.picture === 'live') return true;
    if (login.picture === 'connecting') return waited > EMBED_CONNECTING_MS;
    return login.picture === '' && waited > EMBED_QUIET_MS;
  }

  // Bash's embed says how its picture is doing: { type: 'vestra:embed', state: 'connecting' | 'live' | 'error' }, once per
  // change, live at its first frame. Only the frame up now is heard, from Watch's own origin; anything else is left alone.
  window.addEventListener('message', function (e) {
    var d = e.data;
    var frame = login.framed ? $('login-frame').querySelector('iframe') : null;
    if (!WATCH_ORIGIN || e.origin !== WATCH_ORIGIN || !frame || e.source !== frame.contentWindow) return;
    if (!d || d.type !== 'vestra:embed') return;
    if (d.state !== 'connecting' && d.state !== 'live' && d.state !== 'error') return;
    login.picture = d.state;
    renderSheet();
  });

  // The sheet in login mode, for the card it was opened on. It closes when the hand-off ends or you play someone else.
  sheetLogin = function (c) {
    var on = sheet.mode === 'login';
    $('sheet-login').hidden = !on;
    if (!on) return;
    if (!(isHandoff(c) || isOpening(c)) || c.for_person_ids.indexOf(me) < 0) {
      closeSheet();
      return;
    }
    var watch = watchOf(c);
    var key = keyOf(c, me);
    var s = watch ? login.sessions[key] : null;
    var ixigo = c.kind === 'notice';
    $('sheet-title').textContent = ixigo ? 'Log in to ixigo' : c.title;
    $('login-line').textContent = ixigo ? IXIGO_LINE : "Go's computer is yours for this step.";
    $('login-note').hidden = c.tone !== 'heads_up';
    $('login-note').textContent = c.tone === 'heads_up' ? c.body || '' : '';
    var framed = login.framed === key;
    $('login-frame').hidden = !framed;
    var slow = watch && !s && Date.now() - login.asked[key] > WATCH_WAIT_MS;
    var why = s && s.why ? s.why : (framed && login.picture === 'error') || slow ? 'refused' : '';
    // Over the frame, which keeps loading under it, until its picture is up.
    $('login-wait').hidden = framed && !why && pictureUp();
    $('login-why').textContent = why === 'ended' ? 'Your view of the login closed after 15 minutes.' : why ? "Go's screen didn't open here." : OPENING;
    $('login-progress').hidden = !!why;
    $('login-again').hidden = !why;
    $('login-acts').innerHTML = loginButtons(c);
  };

  $('login-again').addEventListener('click', function () {
    var c = handoffFor(me);
    if (!c) return;
    tapWatch(c, me);
    syncLogin();
    renderSheet();
  });
`;
