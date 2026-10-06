export const VAULT_CSS = `:root{--ink:#0A0A0A;--muted:#5F5F5A;--line:#E8E6E1;--soft:#F7F6F3;--good:#1F7A4D;--good-soft:#E8F5EE;--bad:#B42318;--radius:16px;color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;background:#FFFFFF;color:var(--ink)}
body{font:17px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:440px;margin:0 auto;padding:28px 20px 48px}
.top{margin-bottom:20px}
.mark{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--ink);color:#fff;font-weight:700;font-size:15px}
h1{font-size:28px;line-height:1.15;letter-spacing:-0.02em;margin:14px 0 6px}
h2{font-size:19px;letter-spacing:-0.01em;margin:0 0 10px}
.card{background:var(--soft);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:14px 0}
.muted{color:var(--muted);margin:4px 0}
.fine{color:var(--muted);font-size:13px;margin:10px 0 0}
.amount{font-size:40px;font-weight:700;letter-spacing:-0.03em;margin:0;font-variant-numeric:tabular-nums}
.merchant{font-weight:600;margin:6px 0 2px}
.refund{color:var(--good);background:var(--good-soft);border-radius:10px;padding:8px 10px;font-size:15px;margin:12px 0 0}
.row{display:flex;justify-content:space-between;gap:12px;padding:14px 0;border-top:1px solid var(--line);margin-top:14px}
button{font:inherit;border:0;border-radius:14px;min-height:52px;width:100%;padding:0 18px;font-weight:600;cursor:pointer}
button.primary{background:var(--ink);color:#fff}
button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}
button.big{min-height:58px;font-size:18px;margin-top:8px}
button:disabled{opacity:.5;cursor:default}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 6px}
input,.field{display:block;width:100%;margin-top:6px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fff;font:inherit;color:var(--ink)}
form button{margin-top:14px}
.list{list-style:none;padding:0;margin:0 0 6px}
.list li{padding:10px 0;border-bottom:1px solid var(--line)}
.list li:last-child{border-bottom:0}
.small li{font-size:14px;color:var(--muted)}
.msg{min-height:1.4em;margin:10px 0 0;font-size:15px}
.msg[data-tone="bad"]{color:var(--bad)}
.msg[data-tone="good"]{color:var(--good)}
.done{text-align:center}
.tick{width:56px;height:56px;margin:4px auto 10px;border-radius:50%;display:grid;place-items:center;background:var(--good-soft);color:var(--good);font-size:28px;font-weight:700}
[hidden]{display:none!important}
`;

/** The one script both pages run. It reads the token from the address, never from the HTML. */
export const VAULT_JS = `(() => {
  'use strict';
  const parts = location.pathname.split('/');
  const base = '/' + parts[1] + '/' + parts[2];
  const $ = (id) => document.getElementById(id);
  const show = (id, on = true) => { const el = $(id); if (el) el.hidden = !on; };
  const say = (id, text, tone) => { const el = $(id); if (!el) return; el.textContent = text || ''; el.dataset.tone = tone || ''; };
  const W = window.SimpleWebAuthnBrowser;
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const li = (text) => { const el = document.createElement('li'); el.textContent = text; return el; };

  async function api(path, body) {
    const init = body === undefined
      ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(base + path, init);
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    return { ok: res.ok, status: res.status, data };
  }

  let stripe = null;
  let cardField = null;

  async function home() {
    ['loading', 'expired', 'register', 'unlock', 'open'].forEach((id) => show(id, false));
    const r = await api('/state');
    const s = r.data.state;
    if (s === 'register') { show('register'); return; }
    if (s === 'unlock') { show('unlock'); return; }
    if (s !== 'open') { show('expired'); return; }
    show('open');
    $('cards').replaceChildren(...r.data.cards.map((c) => li(c.brand_label + ' ending ' + c.last4 + ', expires ' + c.expires)));
    show('cards-empty', r.data.cards.length === 0);
    $('log').replaceChildren(...r.data.log.map((e) => li(e.when + ': ' + e.text)));
    if (!stripe && window.Stripe) {
      stripe = window.Stripe(r.data.publishable_key);
      cardField = stripe.elements().create('card', { hidePostalCode: true });
      cardField.mount('#card-element');
    }
    if (r.data.start === 'add_card') $('card-form').scrollIntoView();
  }

  async function ceremony(kind, msgId) {
    say(msgId, '');
    const o = await api('/' + kind + '/options', {});
    if (!o.ok) { say(msgId, o.data.message || 'Could not start. Try again.', 'bad'); return; }
    let response;
    try {
      response = kind === 'register'
        ? await W.startRegistration({ optionsJSON: o.data.options })
        : await W.startAuthentication({ optionsJSON: o.data.options });
    } catch (e) { say(msgId, 'Cancelled. Try again.', 'bad'); return; }
    const v = await api('/' + kind + '/verify', { challenge_id: o.data.challenge_id, response });
    if (!v.ok) { say(msgId, v.data.message || "That didn't work. Try again.", 'bad'); return; }
    await home();
  }

  async function saveCard(ev) {
    ev.preventDefault();
    if (!stripe || !cardField) { say('card-msg', "Cards can't be added right now.", 'bad'); return; }
    say('card-msg', 'Saving');
    const setup = await api('/cards/setup', {});
    if (!setup.ok) { say('card-msg', setup.data.message || "Cards can't be added right now.", 'bad'); return; }
    const result = await stripe.confirmCardSetup(setup.data.client_secret, { payment_method: { card: cardField } });
    if (result.error) { say('card-msg', result.error.message || 'The card was not accepted.', 'bad'); return; }
    const saved = await api('/cards', { setup_intent_id: result.setupIntent.id });
    if (!saved.ok) { say('card-msg', saved.data.message || 'The card was not saved.', 'bad'); return; }
    cardField.clear();
    say('card-msg', 'Card saved.', 'good');
    await home();
  }

  async function pay() {
    const r = await api('/info');
    show('loading', false);
    const d = r.data;
    if (d.state !== 'ready') { $('gone-title').textContent = d.title || 'This link has expired'; say('gone-msg', d.message); show('gone'); return; }
    $('amount').textContent = d.amount_label;
    $('merchant').textContent = d.merchant;
    $('purpose').textContent = d.purpose;
    if (d.refundable_label) { $('refund').textContent = d.refundable_label; show('refund'); }
    $('card').textContent = d.card_label;
    $('approve-btn').textContent = 'Approve with ' + (apple ? 'Face ID' : 'your passkey');
    show('pay');
  }

  async function approve() {
    const btn = $('approve-btn');
    btn.disabled = true;
    say('pay-msg', '');
    const o = await api('/options', {});
    if (!o.ok) { say('pay-msg', o.data.message, 'bad'); return; }
    let response;
    try { response = await W.startAuthentication({ optionsJSON: o.data.options }); }
    catch (e) { say('pay-msg', 'Cancelled. Tap Approve to try again.', 'bad'); btn.disabled = false; return; }
    say('pay-msg', 'Paying');
    try {
      const r = await api('/approve', { challenge_id: o.data.challenge_id, response });
      if (r.data.state === 'paid') { show('pay', false); show('done'); return; }
      say('pay-msg', r.data.message || "The payment didn't go through.", 'bad');
      if (r.data.retry) btn.disabled = false;
    } catch (e) {
      say('pay-msg', 'Something went wrong. Check the card in Go before trying again.', 'bad');
    }
  }

  if (document.body.dataset.page === 'home') {
    $('register-btn').addEventListener('click', () => ceremony('register', 'register-msg'));
    $('unlock-btn').addEventListener('click', () => ceremony('unlock', 'unlock-msg'));
    $('card-form').addEventListener('submit', saveCard);
    home();
  } else {
    $('approve-btn').addEventListener('click', approve);
    pay();
  }
})();
`;
