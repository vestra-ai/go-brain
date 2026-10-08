// The trip's computer in the chat (roomPage). A working card (a search, a job) shows a mini browser: its newest picture
// under a browser's bar, and in a room with Go Live, the computer's own live picture while the card runs (live-page.ts).
// A tap opens it big in one sheet over the chat: view-only and live, with Close. The sheet's login mode (login-panel.ts)
// holds a hand-off's own screen. The sheet sits outside the chat, so what it holds outlives every redraw of the room.
// Like the room's own script, everything here sits inside template literals: no backticks, no dollar-brace and no
// backslashes in it.

export const BROWSER_CSS = `
.mini { display: block; width: 100%; margin-top: 10px; padding: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--panel); font: inherit; color: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
.mini-bar { display: flex; align-items: center; gap: 5px; padding: 6px 10px; background: #f1f5f9; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.mini-bar i { width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; flex: none; }
.mini-host { margin-left: 6px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-live { font-size: 10px; font-weight: 700; letter-spacing: .05em; color: #fff; background: #dc2626; border-radius: 6px; padding: 1px 6px; flex: none; }
.mini-live[hidden] { display: none; }
/* A picture at its own size or smaller, never stretched, centred on the browser's grey; it takes no pointer. */
.mini-view { display: flex; align-items: center; justify-content: center; aspect-ratio: 16 / 10; background: #e2e8f0; overflow: hidden; }
.mini-view img { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; pointer-events: none; }
.mini-view img:not([src]) { display: none; }
.mini-tap { display: block; padding: 8px 10px; font-size: 13px; color: var(--go-ink); border-top: 1px solid var(--line); }
.sheet { position: fixed; inset: 0; z-index: 9; background: rgba(15, 23, 42, 0.55); display: flex; align-items: stretch; justify-content: center; }
.sheet[hidden] { display: none; }
.sheet-panel { width: min(960px, 100%); height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.sheet.login .sheet-panel { width: min(560px, 100%); }
.sheet-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; padding-top: calc(10px + env(safe-area-inset-top)); background: var(--panel); border-bottom: 1px solid var(--line); }
.sheet-bar b { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 16px; }
.sheet-bar .act { margin-top: 0; font-size: 14px; padding: 8px 14px; flex: none; }
.sheet-view { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 12px; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
.sheet-view[hidden] { display: none; }
.sheet-view img { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; border-radius: 10px; box-shadow: 0 4px 18px rgba(15, 23, 42, 0.18); pointer-events: none; }
body.sheet-open { overflow: hidden; }
.toast { z-index: 10; }
@media (min-width: 700px) { .sheet-panel { height: calc(100% - 48px); margin-top: 24px; border-radius: 16px; overflow: hidden; } }
`;

/** The sheet over the chat. `attrs`: its other attributes, escaped; `login`: its login mode's part (login-panel.ts). */
export const browserSheet = (attrs: string, login: string): string => `<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" hidden${attrs}>
  <div class="sheet-panel">
    <div class="sheet-bar"><b id="sheet-title"></b><span class="mini-live" id="sheet-live" hidden>LIVE</span><button class="act secondary" id="sheet-close" type="button">Close</button></div>
    <div class="sheet-view" id="sheet-view" hidden><img id="sheet-img" alt=""></div>
${login}  </div>
</div>
`;

/** Inside the room's script, before Go Live's: render() notes the running cards first and draws the sheet last. */
export const BROWSER_SCRIPT = `
  // The trip's computer in the chat. liveShot (Go Live, live-page.ts): the newest live picture and when it came, or null.
  // runningSince: when this page first saw each working card running; liveCard: the newest running one, the card the
  // live picture belongs to. handoffMine, watchOpensSheet and sheetLogin (login-panel.ts): whether a card hands Go's screen
  // to the person you play, so its sheet is their screen; whether a button on it opens that sheet; and the sheet's part.
  var liveShot = function () { return null; };
  var runningSince = {};
  var liveCard = '';
  var handoffMine = function () { return false; };
  var watchOpensSheet = function () { return false; };
  var sheetLogin = function () {};
  var sheet = { mode: '', card: '' };

  function cardById(id) {
    var list = state ? state.messages : [];
    for (var i = list.length - 1; i >= 0; i--) if (list[i].card && !list[i].deleted && list[i].card.card_id === id) return list[i].card;
    return null;
  }
  /** Before the room is drawn: which working card runs newest, and since when each one runs. */
  function noteRunning() {
    liveCard = '';
    var list = state ? state.messages : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].deleted ? null : list[i].card;
      if (!c || c.kind !== 'working') continue;
      if (c.state === 'running') {
        if (!runningSince[c.card_id]) runningSince[c.card_id] = Date.now();
        liveCard = c.card_id;
      } else delete runningSince[c.card_id];
    }
  }
  /** A working card's picture: the computer's live one while it is the card running and the picture came since, else its own. */
  function browserPicture(c) {
    var shot = c.card_id === liveCard ? liveShot() : null;
    if (shot && shot.got >= runningSince[c.card_id]) return { src: shot.src, live: true };
    return { src: picture(c.card_id, c.screenshot_url), live: false };
  }
  /** The mini browser on a working card: its picture under a browser's bar. A tap opens it big. */
  function miniBrowser(c, host) {
    var b = browserPicture(c);
    var running = c.card_id === liveCard;
    if (!b.src && !running && !handoffMine(c.card_id)) return '';
    return '<button class="mini" type="button" data-browse="' + esc(c.card_id) + '"><span class="mini-bar"><i></i><i></i><i></i><span class="mini-host">' + esc(host) + '</span>' +
      (running ? '<span class="mini-live" id="mini-live-badge"' + (b.live ? '' : ' hidden') + '>LIVE</span>' : '') + '</span>' +
      '<span class="mini-view"><img alt=""' + (b.src ? ' src="' + esc(b.src) + '"' : '') + (running ? ' id="mini-live"' : '') + '></span>' +
      '<span class="mini-tap">' + (handoffMine(c.card_id) ? "Tap to use Go's computer" : 'Tap to see it big') + '</span></button>';
  }
  /** A new live picture: onto the running card's mini browser and the open sheet, in place, without drawing the room again. */
  function liveFramed() {
    var shot = liveShot();
    if (!shot || !liveCard || !(shot.got >= runningSince[liveCard])) return;
    var img = $('mini-live');
    if (img && img.getAttribute('src') !== shot.src) img.setAttribute('src', shot.src);
    if ($('mini-live-badge')) $('mini-live-badge').hidden = false;
    if (sheet.mode === 'view' && sheet.card === liveCard) renderSheet();
  }

  /** Opens a card big: your hand-off as your screen, a working card's picture to look at. Nothing else opens. */
  function openSheet(cardId) {
    var c = cardById(cardId);
    var mode = handoffMine(cardId) ? 'login' : c && c.kind === 'working' ? 'view' : '';
    if (!mode) return;
    if (cardId !== sheet.card) $('sheet-img').removeAttribute('src');
    sheet.mode = mode;
    sheet.card = cardId;
    renderSheet();
  }
  function closeSheet() {
    sheet.mode = '';
    sheet.card = '';
    renderSheet();
  }
  function renderSheet() {
    var c = sheet.card ? cardById(sheet.card) : null;
    if (!c) { sheet.mode = ''; sheet.card = ''; }
    $('sheet').hidden = !sheet.mode;
    $('sheet').className = 'sheet' + (sheet.mode === 'login' ? ' login' : '');
    document.body.className = sheet.mode ? 'sheet-open' : '';
    $('sheet-view').hidden = sheet.mode !== 'view';
    $('sheet-live').hidden = true;
    if (sheet.mode === 'view') {
      var b = browserPicture(c);
      $('sheet-title').textContent = c.title || "Go's computer";
      var img = $('sheet-img');
      // A picture that hasn't loaded yet leaves the last one up: the sheet never blanks.
      if (b.src && img.getAttribute('src') !== b.src) img.setAttribute('src', b.src);
      $('sheet-live').hidden = !b.live;
    }
    sheetLogin(c);
  }
  $('sheet-close').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet.mode) closeSheet(); });
`;
