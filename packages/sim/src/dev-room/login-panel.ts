// Go Live's login panel, inside its column (roomPage({ live: true, watchOrigin })). When a login hand-off waits on the
// person you are playing, the column is Go's screen for them, in control (on a phone, a sheet over the chat), and they
// type their own number and code there. Everyone else's column says who is on Go's computer and never shows the page.
// The screen is the hand-off card's Watch answer, which the room sends to the tapping socket only: the page taps Watch
// itself, once per hand-off, and frames the answer when it is on Bash's session page (watchOrigin). Between the person's
// Log in tap and Watch (Go brings the login page in front first: about 2 s, or 9 to 12 s when the computer wakes), the
// column already says it is opening. When the hand-off ends (logged in, Not now, out of time), it goes back to the live
// view.
// Like the room's own script, everything here sits inside template literals: no backticks, no dollar-brace and no
// backslashes in it.

/** The card actions that answer with Go's screen: a working card's Watch, and the ixigo login card's. */
export const WATCH_ACTIONS: readonly string[] = ['watch', 'ixigo_watch'];
/** The action only the ixigo login card in its logging-in state carries: with no Watch yet, the login is opening. */
export const LOGGING_IN_ACTIONS: readonly string[] = ['ixigo_logged_in'];

export const LOGIN_CSS = `
.live [hidden] { display: none !important; }
.live.mine .screen, .live.mine .live-note, .live.mine .strip-head, .live.mine .strip, .live.other .screen { display: none; }
.login { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.login-bar { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.login-bar b { display: block; font-size: 15px; }
.login-bar span { display: block; color: var(--muted); font-size: 13px; }
.login-bar .act { margin-top: 0; flex: none; }
.login-back { display: none; }
.login-frame { flex: 1; min-height: 480px; position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.login-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.login-wait { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 28px 16px; color: var(--muted); font-size: 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
/* While the login opens: a thin bar that drifts, calm; still for anyone who asks for less motion. */
.login-progress { position: relative; width: 160px; height: 3px; border-radius: 999px; background: #e0f2fe; overflow: hidden; }
.login-progress i { position: absolute; top: 0; bottom: 0; left: -40%; width: 40%; border-radius: 999px; background: var(--go); animation: login-drift 1.6s ease-in-out infinite; }
@keyframes login-drift { from { left: -40%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .login-progress i { animation: none; left: 30%; } }
.login .actions { margin-top: 0; }
.login-note { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 12px; padding: 8px 12px; color: var(--warn); font-size: 14px; }
.handoff { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; aspect-ratio: 16 / 10; padding: 20px; border-radius: 12px; background: #0f172a; color: #cbd5e1; font-size: 14px; }
.handoff b { color: #fff; font-size: 17px; }
.handoff small { color: #94a3b8; font-size: 12px; }
.loginpill { display: none; }
.toast { z-index: 6; }
@media (max-width: 1099px) {
  .live.mine:not(.away) .login { position: fixed; inset: 0; z-index: 5; padding: calc(10px + env(safe-area-inset-top)) 12px calc(10px + env(safe-area-inset-bottom)); background: #eef1f6; }
  .live.mine:not(.away) .login-back { display: inline-flex; }
  .live.mine:not(.away) .login-frame { min-height: 0; }
  .live.mine.away .loginpill { display: block; position: fixed; left: 50%; top: calc(10px + env(safe-area-inset-top)); transform: translateX(-50%); z-index: 4; font: inherit; font-size: 14px; border: 0; border-radius: 999px; background: var(--warn); color: #fff; min-height: 44px; padding: 8px 18px; cursor: pointer; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18); touch-action: manipulation; }
}
`;

/** Inside Go Live's column, under its head: the other person's tile, your login, and the phone's way back to it. */
export const LOGIN_PANEL = `  <div class="handoff" id="handoff" hidden></div>
  <section class="login" id="login" aria-label="Your log in on Go's computer" hidden>
    <div class="login-bar"><div><b id="login-title"></b><span id="login-line"></span></div><button class="act secondary login-back" id="login-back" type="button">Back to the chat</button></div>
    <div class="login-note" id="login-note" role="status" hidden></div>
    <div class="login-frame" id="login-frame"></div>
    <div class="login-wait" id="login-wait" hidden><span id="login-why"></span><div class="login-progress" id="login-progress" aria-hidden="true"><i></i></div><button class="act primary" id="login-again" type="button" hidden>Open the login again</button></div>
    <div class="actions" id="login-acts"></div>
  </section>
  <button class="loginpill" id="loginpill" type="button">Finish logging in</button>
`;

/** Inside the room's script, after Go Live's: render() calls renderLogin, and a tap's answer goes to watchHere first. */
export const LOGIN_SCRIPT = `
  // A login hand-off on Go's screen. login.asked: when this tab tapped Watch for each hand-off (card and person);
  // login.sessions: each one's screen as Watch answered it, or why there is none; login.framed: the hand-off whose screen
  // is in the frame, kept while you play someone else, so a half-typed number is still there when you come back.
  var WATCH = ${JSON.stringify(WATCH_ACTIONS)};
  var LOGGING_IN = ${JSON.stringify(LOGGING_IN_ACTIONS)};
  var WATCH_ORIGIN = $('live').getAttribute('data-watch-origin') || '';
  var WATCH_WAIT_MS = 10000;
  var login = { asked: {}, sessions: {}, framed: '', away: false, awayFor: '' };

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
  /**
   * The newest hand-off for this person, or with none named the newest for anyone but you. With opening, a login still
   * opening counts too.
   */
  function handoffFor(who, opening) {
    var list = cards(function (c) { return isHandoff(c) || (opening && isOpening(c)); });
    for (var i = list.length - 1; i >= 0; i--) {
      var mine = list[i].for_person_ids.indexOf(me) >= 0;
      if (who ? list[i].for_person_ids.indexOf(who) >= 0 : !mine) return list[i];
    }
    return null;
  }
  function stillOpen(key) {
    return handoffs().some(function (c) { return c.for_person_ids.some(function (p) { return keyOf(c, p) === key; }); });
  }
  /** Bash's session page, the only page the panel frames. */
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

  // A Watch answer for a hand-off puts its screen in the panel; anything else opens as it always did.
  watchHere = function (data) {
    if (!state || !WATCH_ORIGIN || WATCH.indexOf(data.actionId) < 0) return false;
    var c = handoffFor(data.personId);
    if (!c || c.card_id !== data.cardId) return false;
    var key = keyOf(c, data.personId);
    var r = data.result || {};
    var url = r.result === 'open' ? frameable(r.url) : '';
    if (!url) {
      login.sessions[key] = { why: 'refused' };
      renderLogin();
      return false;
    }
    var ends = Date.parse(r.expires_at) || Date.now() + 15 * 60000;
    login.sessions[key] = { url: url, ends: ends };
    setTimeout(renderLogin, Math.max(0, ends - Date.now()) + 50);
    renderLogin();
    return true;
  };

  function renderLogin() {
    if (!state) return;
    var mine = WATCH_ORIGIN ? handoffFor(me, true) : null;
    var other = mine ? null : handoffFor(null, true);
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
    }
    // A new hand-off comes up in front, on a phone too.
    if (key !== login.awayFor) { login.away = false; login.awayFor = key; }
    $('live').className = 'live' + (mine ? ' mine' + (login.away ? ' away' : '') : other ? ' other' : '');
    $('login').hidden = !mine;
    $('handoff').hidden = !other;
    if (other) {
      var who = nameOf(other.for_person_ids[0]);
      $('handoff').innerHTML = '<b>' + esc(who) + " is on Go's computer</b><span>" + esc(other.title || '') + '</span><small>Only ' + esc(who) + ' sees this page.</small>';
    }
    if (!mine) return;
    $('login-title').textContent = 'Your turn: ' + (mine.title || '');
    $('login-line').textContent = !watch || watch.action_id === 'ixigo_watch' ? 'Type your number and the code. They go to ixigo only. Go never sees them.' : "Go's computer is yours for this step.";
    // Go turns the card to a heads-up when I'm logged in found no login yet: its words, where the person is looking.
    $('login-note').hidden = mine.tone !== 'heads_up';
    $('login-note').textContent = mine.tone === 'heads_up' ? mine.body || '' : '';
    $('login-frame').hidden = login.framed !== key;
    var slow = watch && !s && now - login.asked[key] > WATCH_WAIT_MS;
    var why = s && s.why ? s.why : slow ? 'refused' : '';
    $('login-wait').hidden = login.framed === key;
    $('login-why').textContent = why === 'ended' ? 'Your view of the login closed after 15 minutes.' : why ? "Go's screen didn't open here." : "Opening ixigo's login on Go's computer…";
    $('login-progress').hidden = !!why;
    $('login-again').hidden = !why;
    $('login-acts').innerHTML = (mine.actions || []).filter(function (a) { return WATCH.indexOf(a.action_id) < 0 && visible(a); })
      .map(function (a) { return goButton(mine, a, ''); }).join('');
  }

  $('login-again').addEventListener('click', function () {
    var c = handoffFor(me);
    if (!c) return;
    tapWatch(c, me);
    renderLogin();
  });
  // On a phone the login is a sheet over the chat: back to the chat, and the pill brings it up again.
  $('login-back').addEventListener('click', function () { login.away = true; renderLogin(); });
  $('loginpill').addEventListener('click', function () { login.away = false; renderLogin(); });
`;
