// The dev room: one self-contained page. Its script is plain ES5 built with string concatenation, because it
// lives inside this template literal: no backticks, no dollar-brace and no backslashes in it.
// roomPage() draws the hosted "try Go" room from the same page: its own title, "Start over", the lines about what is
// live and what is simulated, example messages to tap, the limit line, and a nonce on the script for a strict
// Content-Security-Policy. With no options it is the dev room. It is one column, like the App: a working card shows the
// trip's computer as a mini browser that opens big in a sheet (browser.ts). With live, Go Live feeds that browser and its
// runs sit behind Details (live-page.ts); with watchOrigin too, the login card opens Go's screen in the sheet for the
// person logging in (login-panel.ts).

import { BROWSER_CSS, BROWSER_SCRIPT, browserSheet } from './browser.js';
import { LIVE_CSS, LIVE_DETAILS, LIVE_HOOK, LIVE_SCRIPT } from './live-page.js';
import { LOGIN_CSS, LOGIN_SCRIPT, LOGIN_SHEET, WATCH_ACTIONS } from './login-panel.js';

export interface RoomPageOptions {
  /** The page's title and the header's first line. Default "Go dev room". */
  title?: string;
  /** The script's nonce, for a Content-Security-Policy that allows only this script. */
  nonce?: string;
  /** Example messages above the message box. A tap puts one in the box. */
  hints?: readonly string[];
  /** The hosted room: "Start over", the lines about what is live, the limit line, and a reload to the passcode page when the socket keeps failing. */
  hosted?: boolean;
  /** Go Live: the trip's computer live in the search card's mini browser, and the recipe runs behind Details. */
  live?: boolean;
  /** With live: Bash's session page origin. A login hand-off's Watch answer on it is framed in the sheet. */
  watchOrigin?: string;
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function roomPage(o: RoomPageOptions = {}): string {
  const title = escHtml(o.title ?? 'Go dev room');
  const titleDiv = `<div class="title" id="title">${title}<small>connecting</small></div>`;
  const details = o.live ? '<button class="act secondary" type="button" id="details-open" aria-controls="details" aria-expanded="false">Details</button>' : '';
  const startOver = o.hosted ? '<button class="act secondary" type="button" data-start-over="1">Start over</button>' : '';
  const top = (details || startOver ? `<div class="top">${titleDiv}<span class="top-acts">${details}${startOver}</span></div>` : titleDiv) +
    (o.hosted ? '\n  <div class="about" id="about"></div>' : '');
  const limit = o.hosted ? '  <div class="limit" id="limit" role="status"></div>\n' : '';
  const hints = o.hints?.length
    ? `  <div class="hints"><span>Try:</span>${o.hints.map((h) => `<button class="hint" type="button" data-fill="${escHtml(h)}">${escHtml(h)}</button>`).join('')}</div>\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>
:root { --bg: #f6f7f9; --panel: #ffffff; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --go: #38bdf8; --go-ink: #0369a1; --accent: #0f172a; --warn: #b45309; --column: 600px; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #e9ecf1; color: var(--ink); font-size: 15px; line-height: 1.45; }
.app { max-width: var(--column); margin: 0 auto; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; background: var(--bg); }
header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 12px; padding-top: calc(10px + env(safe-area-inset-top)); display: flex; flex-direction: column; gap: 8px; }
.title { font-weight: 650; font-size: 17px; }
.title small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
.people { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.person { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; min-height: 44px; padding: 6px 12px 6px 6px; display: flex; flex: none; gap: 6px; align-items: center; cursor: pointer; font: inherit; color: inherit; touch-action: manipulation; }
.person.me { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.avatar { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 650; font-size: 12px; flex: none; }
.avatar.go { background: var(--go); }
.you { display: flex; gap: 8px; align-items: center; justify-content: space-between; color: var(--muted); font-size: 13px; }
.you button.act { margin-top: 0; font-size: 14px; padding: 8px 12px; }
main { flex: 1; padding: 12px 12px 16px; }
.needs { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 14px; padding: 10px 14px; margin-bottom: 16px; }
.needs h2 { font-size: 12px; margin: 0 0 6px; color: var(--warn); text-transform: uppercase; letter-spacing: .04em; }
.needs div { padding: 3px 0; }
.msg { display: flex; gap: 8px; margin: 12px 0; }
.bubble { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 10px 12px; min-width: 0; flex: 1; }
.msg.go .bubble { border-color: #bae6fd; background: #f0f9ff; }
.who { font-weight: 650; font-size: 13px; margin-bottom: 2px; }
.who span { font-weight: 400; color: var(--muted); margin-left: 6px; }
.quote { border-left: 3px solid var(--line); padding-left: 8px; color: var(--muted); font-size: 13px; margin: 4px 0; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--muted); font-style: italic; }
.reactions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
.chip { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 13px; background: var(--panel); margin: 2px 2px 0 0; }
.react { border: 0; background: none; cursor: pointer; opacity: .45; font-size: 16px; min-width: 44px; min-height: 44px; padding: 0; touch-action: manipulation; }
.react:hover { opacity: 1; }
.card { margin-top: 10px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); padding: 12px; }
.card h3 { margin: 0 0 4px; font-size: 15px; }
.meta { color: var(--muted); font-size: 12px; }
.tag { display: inline-block; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 4px; }
.tag.warn { color: var(--warn); }
.row { border-top: 1px solid var(--line); padding: 8px 0; display: flex; gap: 10px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; }
.price { font-weight: 650; white-space: nowrap; }
.big { font-size: 26px; font-weight: 700; }
.bar { height: 6px; background: var(--line); border-radius: 999px; overflow: hidden; margin-top: 4px; }
.bar i { display: block; height: 100%; background: var(--go); }
.steps div { padding: 2px 0; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
button.act { font: inherit; font-size: 15px; border-radius: 12px; min-height: 44px; padding: 10px 16px; cursor: pointer; border: 1px solid var(--accent); margin-top: 4px; touch-action: manipulation; }
button.primary { background: var(--accent); color: #fff; }
button.secondary { background: var(--panel); color: var(--accent); }
a.act { display: inline-flex; align-items: center; text-decoration: none; font: inherit; font-size: 15px; border-radius: 12px; min-height: 44px; padding: 10px 16px; border: 1px solid var(--accent); margin-top: 4px; background: var(--panel); color: var(--accent); }
.typing { color: var(--go-ink); font-size: 13px; min-height: 20px; margin: 4px 0 0 36px; }
footer { position: sticky; bottom: 0; z-index: 2; background: var(--panel); border-top: 1px solid var(--line); padding: 10px 12px; padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
form { display: flex; gap: 8px; }
input[type=text] { flex: 1; font: inherit; font-size: 16px; min-height: 44px; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; min-width: 0; }
.toast { position: fixed; left: 50%; bottom: calc(84px + env(safe-area-inset-bottom)); transform: translateX(-50%); background: var(--accent); color: #fff; border-radius: 10px; padding: 8px 14px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: calc(var(--column) - 32px); width: max-content; }
.toast.show { opacity: 1; }
.newpill { position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%); margin-bottom: 8px; font: inherit; font-size: 13px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; min-height: 44px; padding: 8px 16px; cursor: pointer; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18); touch-action: manipulation; }
.newpill[hidden] { display: none; }
.top { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.top-acts { display: flex; gap: 6px; flex: none; }
.top button.act { margin-top: 0; font-size: 14px; padding: 8px 12px; flex: none; }
.about { color: var(--muted); font-size: 12px; }
.limit { color: var(--warn); font-size: 13px; margin-bottom: 8px; }
.limit:empty { display: none; }
.hints { display: flex; gap: 6px; align-items: center; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; margin-bottom: 8px; }
.hints span { color: var(--muted); font-size: 13px; flex: none; }
button.hint { flex: none; font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 999px; min-height: 44px; padding: 6px 12px; cursor: pointer; touch-action: manipulation; }
${BROWSER_CSS}${o.live ? LIVE_CSS + LOGIN_CSS : ''}</style>
</head>
<body${o.hosted ? ' data-hosted="1"' : ''}>
<div class="app">
<header>
  ${top}
  <div class="people" id="people"></div>
  <div class="you" id="you"></div>
</header>
<main>
  <div id="needs"></div>
  <div id="room"></div>
  <div class="typing" id="typing"></div>
</main>
<footer>
  <button class="newpill" id="newpill" type="button" hidden>New messages ↓</button>
${limit}${hints}  <form id="composer"><input type="text" id="text" autocomplete="off" enterkeyhint="send" placeholder="Message the group. Start with @Go to ask Go."><button class="act primary" type="submit">Send</button></form>
</footer>
</div>
${browserSheet(o.live && o.watchOrigin ? ` data-watch-origin="${escHtml(o.watchOrigin)}"` : '', o.live ? LOGIN_SHEET : '')}${o.live ? LIVE_DETAILS : ''}<div class="toast" id="toast"></div>
<script${o.nonce ? ` nonce="${escHtml(o.nonce)}"` : ''}>
(function () {
  var COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#14b8a6'];
  var state = null;
  var me = 'p_rahul';
  var ws = null;
  var fails = 0;
  var toastTimer = null;
  // A login hand-off's Watch answer goes in the sheet (login-panel.ts); without it every page opens in a window.
  var watchHere = function () { return false; };
  // A login card's own part (login-panel.ts), or null: without it the card is drawn as any notice.
  var loginPart = function () { return null; };
  try { me = localStorage.getItem('go-dev-room-me') || me; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function safeUrl(u) { return /^https?:/i.test(String(u || '')) ? String(u) : ''; }
  /** An ixigo.com page, or '': the only pages a "See on ixigo" button opens. */
  function ixigoPage(u) {
    var url = safeUrl(u);
    try {
      var host = url ? new URL(url).hostname : '';
      return host === 'ixigo.com' || host.slice(-10) === '.ixigo.com' ? url : '';
    } catch (e) {
      return '';
    }
  }
  // A card's picture changes only once the new one has loaded, so the card never blanks between pictures: a working
  // card's screenshot comes as a new address about once a second, and the room is drawn afresh on every change.
  // pics.shown: each card's picture on screen; pics.wanted: the newest one asked for, loading. One that fails keeps the old.
  var pics = { shown: {}, wanted: {} };
  function picture(cardId, u) {
    var url = safeUrl(u);
    if (!url || pics.shown[cardId] === url) return url;
    if (pics.wanted[cardId] !== url) {
      pics.wanted[cardId] = url;
      var img = new Image();
      img.onload = function () {
        if (pics.wanted[cardId] !== url) return;
        pics.shown[cardId] = url;
        render();
      };
      img.src = url;
    }
    return pics.shown[cardId] || '';
  }
  function money(minor, cur) {
    if (minor == null) return '';
    var text = Math.round(minor / 100).toLocaleString('en-IN');
    return !cur || cur === 'INR' ? '₹' + text : cur + ' ' + text;
  }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function find(list, key, id) { for (var i = 0; i < list.length; i++) if (list[i][key] === id) return list[i]; return null; }
  function person(id) { return state ? find(state.trip.people, 'person_id', id) : null; }
  function nameOf(id) { var p = person(id); return p ? p.name : String(id); }
  function color(id) {
    var ps = state ? state.trip.people : [];
    for (var i = 0; i < ps.length; i++) if (ps[i].person_id === id) return COLORS[i % COLORS.length];
    return '#94a3b8';
  }
  function avatar(author) {
    if (author.kind === 'go') return '<div class="avatar go">Go</div>';
    if (author.kind === 'system') return '<div class="avatar" style="background:#94a3b8">i</div>';
    return '<div class="avatar" style="background:' + color(author.person_id) + '">' + esc(nameOf(author.person_id).slice(0, 1)) + '</div>';
  }
  function decision(id) { return find(state.trip.decisions, 'decision_id', id); }
  function send(action) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(action)); }
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2500);
  }

  // A card button tapped and waiting, for the person who tapped it. Go answers a tap by changing the card, so the button
  // stays pending (disabled, "Opening…") until the card changes, Go refuses or opens a page, or PENDING_MS pass; a second
  // tap on it is never sent.
  var PENDING_MS = 15000;
  var OPENS = ['watch', 'ixigo_watch', 'ixigo_login'];
  var pending = {};
  function pendingKey(cardId, actionId, optionId, who) { return cardId + ' ' + actionId + ' ' + (optionId || '') + ' ' + who; }
  function cardNow(cardId) {
    var list = state ? state.messages : [];
    for (var i = 0; i < list.length; i++) if (list[i].card && !list[i].deleted && list[i].card.card_id === cardId) return JSON.stringify(list[i].card);
    return '';
  }
  function settlePending() {
    var now = Date.now();
    for (var k in pending) if (now - pending[k].at > PENDING_MS || cardNow(pending[k].card) !== pending[k].was) delete pending[k];
    for (var t in tabs) if (now - tabs[t].at > PENDING_MS) dropTab(t);
  }
  function freePending(cardId, actionId, who) {
    for (var k in pending) if (pending[k].card === cardId && pending[k].action === actionId && pending[k].who === who) delete pending[k];
  }
  // Watch opens Go's screen in a new tab, and a browser lets a page open a tab only inside a tap: the tab opens in the
  // tap, saying it is opening, and goes to Go's answer when it comes; a refusal closes it. tabs: each one waiting, by
  // card, action and person.
  var OPENS_TAB = ${JSON.stringify(WATCH_ACTIONS)};
  var tabs = {};
  function holdTab(cardId, actionId, who) {
    var w = null;
    try { w = window.open('', '_blank'); } catch (e) { w = null; }
    if (!w) return;
    try {
      w.opener = null;
      w.document.title = "Go's screen";
      w.document.body.textContent = "Opening Go's screen…";
    } catch (e) {}
    tabs[pendingKey(cardId, actionId, '', who)] = { w: w, at: Date.now() };
  }
  /** The tab waiting for this tap's answer, if one is: it is the caller's now. */
  function takeTab(cardId, actionId, who) {
    var key = pendingKey(cardId, actionId, '', who);
    var t = tabs[key];
    delete tabs[key];
    return t ? t.w : null;
  }
  function dropTab(key) {
    try { tabs[key].w.close(); } catch (e) {}
    delete tabs[key];
  }

  /** Taps a card's button for that person, once until it settles. False when that button is still waiting. */
  function tapCard(cardId, actionId, optionId, who) {
    var key = pendingKey(cardId, actionId, optionId, who);
    if (pending[key]) return false;
    pending[key] = { card: cardId, action: actionId, who: who, was: cardNow(cardId), at: Date.now() };
    send({ type: 'tap', cardId: cardId, actionId: actionId, personId: who, optionId: optionId || undefined });
    setTimeout(render, PENDING_MS + 50);
    return true;
  }

  function visible(action) { return !action.only_for_person_ids || action.only_for_person_ids.indexOf(me) >= 0; }
  function goButton(card, action, optionId) {
    var busy = !!pending[pendingKey(card.card_id, action.action_id, optionId, me)];
    return '<button class="act ' + (action.style === 'primary' ? 'primary' : 'secondary') + '" data-tap="' + esc(card.card_id) + '" data-action="' + esc(action.action_id) + '"' +
      (optionId ? ' data-option="' + esc(optionId) + '"' : '') + (busy ? ' disabled aria-busy="true"' : '') + '>' +
      esc(busy ? (OPENS.indexOf(action.action_id) >= 0 ? 'Opening…' : 'One moment…') : action.label) + '</button>';
  }
  function goActions(card) {
    var acts = (card.actions || []).filter(function (a) { return !a.per_option && visible(a); });
    return acts.length ? '<div class="actions">' + acts.map(function (a) { return goButton(card, a, ''); }).join('') + '</div>' : '';
  }
  function items(list) {
    return list.map(function (i) {
      return '<div class="row"><div>' + esc(i.time || '') + ' ' + esc(i.title) + (i.status === 'idea' ? ' <span class="chip">idea</span>' : '') +
        (i.status === 'booked' ? ' <span class="chip">booked</span>' : '') + '</div></div>';
    }).join('');
  }
  function fallback(c) { return '<div>' + esc(c.fallback_text) + '</div>'; }

${BROWSER_SCRIPT}
  var RENDER = {
    vote: function (c) {
      var d = decision(c.decision_id);
      if (!d) return fallback(c);
      var total = Math.max(1, d.voted);
      var mine = null;
      (d.votes || []).forEach(function (v) { if (v.person_id === me) mine = v.option_index; });
      var rows = d.options.map(function (o, i) {
        var n = d.tally[i] || 0;
        var won = d.status === 'closed' && d.result_index === i;
        var btn = d.status === 'open' ? '<button class="act ' + (mine === i ? 'primary' : 'secondary') + '" data-vote="' + esc(d.decision_id) + '" data-index="' + i + '">' + (mine === i ? 'Your vote' : 'Vote') + '</button>' : '';
        return '<div class="row"><div style="flex:1;min-width:160px"><b>' + esc(o.label) + (won ? ' (won)' : '') + '</b>' + (o.note ? '<div class="meta">' + esc(o.note) + '</div>' : '') +
          '<div class="bar"><i style="width:' + Math.round(100 * n / total) + '%"></i></div></div><div class="price">' + money(o.price_minor, o.currency) + '</div>' + btn + '</div>';
      }).join('');
      var status = d.status === 'open' ? d.voted + ' of ' + d.of + ' voted' + (d.closes_at ? ', closes ' + when(d.closes_at) : '')
        : d.status === 'closed' ? (d.result_index != null ? d.options[d.result_index].label + ' won, ' + d.voted + ' of ' + d.of + ' voted' : 'No winner, Go will ask the group') : 'Called off';
      return '<span class="tag">Vote</span><h3>' + esc(d.question) + '</h3><div class="meta">' + esc(status) + (d.anonymous ? ', anonymous' : '') + '</div>' + rows;
    },
    mandate: function (c) {
      var d = decision(c.decision_id);
      if (!d || !d.mandate) return fallback(c);
      var m = d.mandate;
      var opt = d.options[m.choice_index] || { label: 'the winner' };
      var answer = m.confirmed_at && !(m.declined_at && Date.parse(m.declined_at) > Date.parse(m.confirmed_at)) ? nameOf(m.payer_person_id) + ' said yes'
        : m.declined_at ? nameOf(m.payer_person_id) + ' said not now' : '';
      var bottom = answer ? '<div class="meta">' + esc(answer) + '</div>'
        : me === m.payer_person_id ? '<div class="actions"><button class="act primary" data-confirm="' + esc(d.decision_id) + '">Yes, book it</button><button class="act secondary" data-decline="' + esc(d.decision_id) + '">Not now</button></div>'
        : '<div class="meta">Waiting for ' + esc(nameOf(m.payer_person_id)) + '</div>';
      return '<span class="tag">Ready to book</span><h3>' + esc(opt.label) + '</h3><div>Up to ' + money(m.cap_minor, m.currency) + (m.refundable_only ? ', refundable only' : '') + '</div>' +
        '<div class="meta">' + esc(nameOf(m.payer_person_id)) + ' pays</div>' + bottom;
    },
    ticket: function (c) {
      var b = find(state.trip.bookings, 'booking_id', c.booking_id);
      if (!b) return fallback(c);
      var j = b.journey;
      var route = j ? esc((j.origin.code || j.origin.name) + ' to ' + (j.destination.code || j.destination.name) + ', ' + when(j.depart_at))
        : esc(b.starts_at ? when(b.starts_at) + (b.ends_at ? ' to ' + when(b.ends_at) : '') : '');
      return '<span class="tag">' + (b.status === 'cancelled' ? 'Cancelled' : 'Booked') + '</span><h3>' + esc(b.title) + '</h3><div>' + route + '</div>' +
        '<div class="meta">' + esc(b.vendor) + ', ref ' + esc(b.ref) + '. ' + esc(nameOf(b.payer_person_id)) + ' paid ' + money(b.amount_minor, b.currency) +
        (b.refundable_until ? '. Free cancellation until ' + esc(when(b.refundable_until)) : '') + '</div>';
    },
    expense: function (c) {
      var e = find(state.trip.expenses, 'expense_id', c.expense_id);
      if (!e) return fallback(c);
      return '<span class="tag">Expense</span><h3>' + esc(e.note) + '</h3><div>' + esc(nameOf(e.paid_by_person_id)) + ' paid ' + money(e.amount_minor, e.currency) + '</div>' +
        '<div class="meta">Split between ' + e.split_person_ids.length + ', ' + money(Math.floor(e.amount_minor / e.split_person_ids.length), e.currency) + ' each</div>';
    },
    settle_up: function () {
      var t = state.trip.money.transfers;
      return '<span class="tag">Settle up</span>' + (t.length ? t.map(function (x) {
        return '<div class="row"><div>' + esc(nameOf(x.from_person_id)) + ' pays ' + esc(nameOf(x.to_person_id)) + '</div><div class="price">' + money(x.amount_minor, x.currency) + '</div></div>';
      }).join('') : '<div>Everyone is square</div>');
    },
    day: function (c) {
      var d = find(state.trip.itinerary, 'date', c.date);
      if (!d) return '<span class="tag">Day</span><h3>' + esc(c.date) + '</h3><div class="meta">Nothing planned for this day yet</div>';
      return '<span class="tag">Day</span><h3>' + esc(c.date) + (d.title ? ', ' + esc(d.title) : '') + '</h3>' + items(d.items);
    },
    plan: function () {
      var days = state.trip.itinerary;
      if (!days.length) return '<span class="tag">Plan</span><div class="meta">No plan yet</div>';
      return '<span class="tag">Plan</span>' + days.map(function (d) { return '<h3 style="margin-top:8px">' + esc(d.date) + (d.title ? ', ' + esc(d.title) : '') + '</h3>' + items(d.items); }).join('');
    },
    budget: function () {
      var m = state.trip.money;
      var pct = m.plan_minor ? Math.min(100, Math.round(100 * m.spent_minor / m.plan_minor)) : 0;
      return '<span class="tag">Budget</span><h3>' + money(m.spent_minor, m.currency) + (m.plan_minor ? ' of ' + money(m.plan_minor, m.currency) : ' spent') + '</h3>' +
        (m.plan_minor ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') +
        m.by_category.map(function (x) { return '<div class="row"><div>' + esc(x.category.replace('_', ' ')) + '</div><div class="price">' + money(x.amount_minor, m.currency) + '</div></div>'; }).join('');
    },
    options: function (c) {
      var per = (c.actions || []).filter(function (a) { return a.per_option && visible(a); });
      return '<span class="tag">' + esc(c.option_kind) + '</span><h3>' + esc(c.title) + '</h3><div class="meta">Checked ' + esc(ago(c.checked_at)) + '</div>' + c.options.map(function (o) {
        var j = o.journey;
        var line = j ? esc((j.origin.code || j.origin.name) + ' to ' + (j.destination.code || j.destination.name) + (j.stops === 0 ? ', non-stop' : '')) : '';
        return '<div class="row"><div style="flex:1;min-width:160px"><b>' + esc(o.title) + '</b>' + (o.subtitle ? '<div class="meta">' + esc(o.subtitle) + '</div>' : '') +
          (line ? '<div class="meta">' + line + '</div>' : '') + '<div>' + (o.highlights || []).map(function (h) { return '<span class="chip">' + esc(h) + '</span>'; }).join('') +
          (o.rating != null ? '<span class="chip">' + esc(o.rating) + ' stars</span>' : '') + (o.refundable_until ? '<span class="chip">Free cancellation</span>' : '') + '</div></div>' +
          '<div><div class="price">' + money(o.price_minor, o.currency) + (o.price_note ? ' <span class="meta">' + esc(o.price_note) + '</span>' : '') + '</div>' +
          per.map(function (a) { return goButton(c, a, o.option_id); }).join('') + '</div></div>';
      }).join('') + goActions(c);
    },
    working: function (c) {
      var label = { running: 'Working on it', needs_you: 'Needs you', done: 'Done', failed: "Didn't work" }[c.state] || c.state;
      var mark = { todo: '○', doing: '◐', done: '●', failed: '×' };
      var see = ixigoPage(c.page_url);
      return '<span class="tag' + (c.state === 'needs_you' ? ' warn' : '') + '">' + esc(label) + '</span><h3>' + esc(c.title) + '</h3><div class="steps">' +
        c.steps.map(function (s) { return '<div>' + (mark[s.state] || '') + ' ' + esc(s.text) + '</div>'; }).join('') + '</div>' +
        miniBrowser(c, see ? 'ixigo.com' : "Go's computer") +
        // The page's address is never shown as text: the picture and the steps say what it is, and the link is a button.
        (see ? '<div class="actions"><a class="act secondary" href="' + esc(see) + '" target="_blank" rel="noopener noreferrer">See on ixigo</a></div>' : '') +
        '<div class="meta">Updated ' + esc(ago(c.updated_at)) + '</div>' + goActions(c);
    },
    call: function (c) {
      var label = { dialing: 'Calling ' + c.business + '...', talking: 'On the call', ended: 'Call ended', failed: "Couldn't get through" }[c.state] || c.state;
      var who = function (l) { return l.who === 'go' ? 'Go' : esc(c.business); };
      return '<span class="tag">' + esc(label) + '</span><h3>' + esc(c.business) + ': ' + esc(c.goal) + '</h3>' +
        (c.last_line ? '<div class="quote">' + who(c.last_line) + ': ' + esc(c.last_line.text) + '</div>' : '') + (c.outcome ? '<div>' + esc(c.outcome) + '</div>' : '') +
        (c.transcript && c.transcript.length ? '<details><summary>Show transcript</summary>' + c.transcript.map(function (l) { return '<div>' + who(l) + ': ' + esc(l.text) + '</div>'; }).join('') + '</details>' : '') +
        goActions(c);
    },
    pay: function (c) {
      var waiting = c.state === 'waiting' && Date.parse(c.expires_at) > Date.now();
      var label = waiting ? 'Waiting for ' + nameOf(c.payer_person_id) : ({ paid: 'Paid', declined: 'Declined', expired: 'Expired', failed: 'Failed', waiting: 'Expired' }[c.state] || c.state);
      return '<span class="tag">Payment</span><div class="big">' + money(c.amount_minor, c.currency) + '</div><div>' + esc(c.merchant) + '</div>' +
        '<div class="meta">' + esc(c.purpose) + (c.refundable_until ? '. Free cancellation until ' + esc(when(c.refundable_until)) : '') + '</div>' +
        '<div class="meta">' + esc(nameOf(c.payer_person_id)) + ' pays. ' + esc(label) + '</div>' + (waiting ? goActions(c) : '');
    },
    notice: function (c) {
      var part = loginPart(c);
      if (part !== null) return part;
      var link = c.source ? safeUrl(c.source.url) : '';
      var src = c.source ? (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(c.source.name) + '</a>' : esc(c.source.name)) : '';
      return '<span class="tag' + (c.tone === 'heads_up' ? ' warn' : '') + '">' + (c.tone === 'heads_up' ? 'Heads up' : 'Good to know') + '</span><h3>' + esc(c.title) + '</h3>' +
        '<div>' + esc(c.body) + '</div><div class="meta">' + src + (c.checked_at ? (src ? ', checked ' : 'Checked ') + esc(ago(c.checked_at)) : '') +
        (c.deadline_at ? '. By ' + esc(when(c.deadline_at)) : '') + '</div>' + goActions(c);
    }
  };

  function card(c) {
    var known = Object.prototype.hasOwnProperty.call(RENDER, c.kind);
    return '<div class="card">' + (known ? RENDER[c.kind](c) : fallback(c)) + '</div>';
  }

  function message(m) {
    var go = m.author.kind === 'go';
    var name = go ? 'Go' : m.author.kind === 'system' ? 'Trip' : nameOf(m.author.person_id);
    var reply = m.reply_to ? find(state.messages, 'message_id', m.reply_to) : null;
    var body = m.deleted ? '<div class="muted">Message deleted</div>'
      : m.withheld ? '<div class="muted">Hidden from Go: this person paused Go</div>'
      : (m.text ? '<div class="text">' + esc(m.text) + '</div>' : '');
    var counts = Object.create(null);
    (m.reactions || []).forEach(function (r) {
      counts[r.emoji] = counts[r.emoji] || [];
      counts[r.emoji].push(r.person_id == null ? 'Go' : nameOf(r.person_id));
    });
    var chips = Object.keys(counts).map(function (k) { return '<span class="chip" title="' + esc(counts[k].join(', ')) + '">' + esc(k) + ' ' + counts[k].length + '</span>'; }).join('');
    var react = m.deleted ? '' : '<button class="react" data-react="' + esc(m.message_id) + '" title="React with a thumbs up">👍</button>';
    var quote = reply ? '<div class="quote">' + esc(reply.author.kind === 'go' ? 'Go' : nameOf(reply.author.person_id)) + ': ' + esc((reply.text || '').slice(0, 120)) + '</div>' : '';
    return '<div class="msg' + (go ? ' go' : '') + '">' + avatar(m.author) + '<div class="bubble"><div class="who">' + esc(name) + '<span>' + esc(when(m.sent_at)) + (m.edited_at ? ', edited' : '') + '</span></div>' +
      quote + body + (m.card && !m.deleted ? card(m.card) : '') + '<div class="reactions">' + chips + react + '</div></div></div>';
  }

  // Whether the reader is at the bottom of the chat, kept from their own scrolling, never measured inside a render: a
  // render rebuilds the room, and its pictures load after it, so the room's height mid-render says nothing about where
  // the reader is. The page scrolls: the room is one column.
  var pinned = true;
  var newest = '';
  function fromBottom() {
    return (document.scrollingElement || document.documentElement).scrollHeight - window.scrollY - window.innerHeight;
  }
  function toBottom() {
    window.scrollTo(0, (document.scrollingElement || document.documentElement).scrollHeight);
  }

  function render() {
    if (!state) return;
    settlePending();
    noteRunning();
    var t = state.trip;
    $('title').innerHTML = esc(t.title) + '<small>' + esc(t.people.length + ' people, change ' + t.seq + (state.connected ? '' : ', Go is not connected')) + '</small>';
    $('people').innerHTML = t.people.map(function (p) {
      return '<button class="person' + (p.person_id === me ? ' me' : '') + '" data-me="' + esc(p.person_id) + '">' + avatar({ kind: 'person', person_id: p.person_id }) + esc(p.name) + '</button>';
    }).join('');
    // The App's You screen, for whoever is "me": only the person can forget themselves.
    $('you').innerHTML = '<span>You are ' + esc(nameOf(me)) + '</span><button class="act secondary" data-forget="' + esc(me) + '">Forget me in this trip</button>';
    var needs = state.needs[me] || [];
    $('needs').innerHTML = needs.length ? '<div class="needs"><h2>Needs you, ' + esc(nameOf(me)) + '</h2>' + needs.map(function (n) { return '<div>' + esc(n.text) + '</div>'; }).join('') + '</div>' : '';
    $('room').innerHTML = state.messages.map(message).join('') || '<div class="muted">No messages yet. Say hello, or start with @Go to ask Go.</div>';
    $('typing').textContent = state.typing ? 'Go is typing...' : '';
    var about = $('about');
    if (about) about.innerHTML = (state.about || []).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    if ($('limit')) $('limit').textContent = state.limit || '';
    // At the bottom before, at the bottom after. Scrolled up to read: left in place, and told about a new message.
    var last = state.messages.length ? state.messages[state.messages.length - 1].message_id : '';
    if (pinned) toBottom();
    else if (last !== newest) $('newpill').hidden = false;
    newest = last;
${o.live ? '    syncLogin();\n' : ''}    renderSheet();
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!el) return;
    var d = el.dataset;
    if (d.me) {
      me = d.me;
      try { localStorage.setItem('go-dev-room-me', me); } catch (x) {}
      render();
    } else if (d.browse) {
      openSheet(d.browse);
    } else if (d.tap) {
      if (watchOpensSheet(d.tap, d.action)) openSheet(d.tap);
      else if (tapCard(d.tap, d.action, d.option, me)) {
        if (OPENS_TAB.indexOf(d.action) >= 0) holdTab(d.tap, d.action, me);
        render();
      }
    } else if (d.vote) {
      send({ type: 'vote', decisionId: d.vote, personId: me, optionIndex: Number(d.index) });
    } else if (d.confirm) {
      send({ type: 'confirm', decisionId: d.confirm });
    } else if (d.decline) {
      send({ type: 'decline', decisionId: d.decline });
    } else if (d.react) {
      send({ type: 'react', personId: me, messageId: d.react, emoji: '👍' });
    } else if (d.forget) {
      send({ type: 'forget', personId: d.forget });
    } else if (d.fill) {
      $('text').value = d.fill;
      $('text').focus();
    } else if (d.startOver) {
      send({ type: 'start_over' });
    }
  });

  // Where the reader is, after any scroll of the page.
  document.addEventListener('scroll', function () {
    pinned = fromBottom() <= 80;
    if (pinned) $('newpill').hidden = true;
  }, true);
  // A picture that loads after a render makes the room taller: a reader at the bottom stays there.
  document.addEventListener('load', function (e) {
    if (pinned && e.target && e.target.tagName === 'IMG' && $('room').contains(e.target)) toBottom();
  }, true);
  $('newpill').addEventListener('click', function () {
    pinned = true;
    $('newpill').hidden = true;
    toBottom();
  });

  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('text');
    var text = input.value.trim();
    if (!text) return;
    send({ type: 'say', personId: me, text: text });
    input.value = '';
  });

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live');
    ws.onmessage = function (ev) {
      var data = JSON.parse(ev.data);
      if (data.type === 'state') {
        var was = person(me);
        state = data;
        if (!person(me) && state.trip.people.length) {
          // A new trip has new ids for the same people: stay the same person, by name.
          var same = was ? find(state.trip.people, 'name', was.name) : null;
          me = same ? same.person_id : state.trip.people[0].person_id;
        }
        render();
      } else if (data.type === 'tap_result') {
        var r = data.result;
        // An answer that isn't a change to the card frees its button at once.
        if (r.result !== 'done') {
          freePending(data.cardId, data.actionId, data.personId);
          render();
        }
        var tab = takeTab(data.cardId, data.actionId, data.personId);
        if (watchHere(data)) { // in the sheet's frame
          if (tab) tab.close();
          return;
        }
        if (r.result === 'open' && safeUrl(r.url)) {
          if (tab) tab.location.href = r.url;
          else window.open(r.url, '_blank', 'noopener');
          toast('Opening the page');
        } else {
          if (tab) tab.close();
          toast(r.toast || (r.result === 'done' ? 'Done' : 'Not allowed'));
        }
      } else if (data.type === 'forget_result') {
        toast(data.toast);
      } else if (data.type === 'limit' || data.type === 'error') {
        // The room turned something away before it reached Go: no tap is on its way, so no button or tab waits.
        pending = {};
        for (var held in tabs) dropTab(held);
        render();
        if (data.type === 'limit' && $('limit')) $('limit').textContent = data.text;
        toast(data.type === 'limit' ? data.text : data.message);
${o.live ? LIVE_HOOK : ''}      }
    };
    ws.onopen = function () { fails = 0; };
    ws.onclose = function (e) {
      // 4429: too many sockets. The room said why in its last message, and another try would be turned away too.
      if (e.code === 4429) return;
      fails += 1;
      // The hosted room refuses a socket without a good passcode cookie: after a few tries, load the passcode page.
      if (document.body.getAttribute('data-hosted') && fails >= 3) { location.reload(); return; }
      setTimeout(connect, 1000);
    };
  }

${o.live ? LIVE_SCRIPT + LOGIN_SCRIPT : ''}  connect();
  setInterval(render, 15000); // keeps "checked 3 min ago" honest
})();
</script>
</body>
</html>
`;
}

export const PAGE_HTML = roomPage();
