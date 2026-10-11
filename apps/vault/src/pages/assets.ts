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
.tick-row{display:flex;gap:10px;align-items:center;color:var(--ink);margin:16px 0}
.tick-row input{display:inline-block;width:auto;margin:0;padding:0}
form button{margin-top:14px}
.list{list-style:none;padding:0;margin:0 0 6px}
.list li{padding:10px 0;border-bottom:1px solid var(--line)}
.list li:last-child{border-bottom:0}
.small li{font-size:14px;color:var(--muted)}
.msg{min-height:1.4em;margin:10px 0 0;font-size:15px}
.msg[data-tone="bad"]{color:var(--bad)}
.msg[data-tone="good"]{color:var(--good)}
.demo-note{background:#FFF6DB;border:1px solid #EFD48A;color:#5C4300;border-radius:10px;padding:10px 12px;font-size:15px;margin:0 0 12px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
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
  // Inside the App (rev 5 R8): the page says when it is done to its parent, at each of the App's origins (only the one
  // that framed it hears it), and an embedded unlock keeps its session in memory for a header, as no cookie reaches it.
  const embedded = document.body.dataset.display === 'embedded';
  const framed = window.parent !== window;
  const origins = (document.body.dataset.frameOrigins || '').split(' ').filter(Boolean);
  let session = null;
  const tellApp = (status) => {
    if (!framed) return;
    for (const origin of origins) { try { window.parent.postMessage({ type: 'go-vault', status }, origin); } catch (e) {} }
  };

  async function api(path, body) {
    const headers = session ? { 'x-vault-session': session } : {};
    const init = body === undefined
      ? { credentials: 'same-origin', headers }
      : { method: 'POST', credentials: 'same-origin', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
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
    if (s !== 'open') { show('expired'); tellApp('failed'); return; }
    show('open');
    $('cards').replaceChildren(...r.data.cards.map((c) => li(c.brand_label + ' ending ' + c.last4 + ', expires ' + c.expires)));
    show('cards-empty', r.data.cards.length === 0);
    $('log').replaceChildren(...r.data.log.map((e) => li(e.when + ': ' + e.text)));
    // stripe: Stripe's card form. demo: the demo's own form, test cards only. off: a vault that can't add cards says so,
    // in place of a form whose Save could only fail.
    const mode = r.data.cards_mode || (r.data.cards_ready === false ? 'off' : 'stripe');
    const cardsReady = mode === 'stripe';
    // Embedded: no card or travel form (card entry stays in the browser sheet), and Done tells the App.
    show('card-form', cardsReady && !embedded);
    show('demo-card-form', mode === 'demo' && !embedded);
    show('cards-not-ready', mode === 'off' && !embedded);
    show('travel-form', !embedded);
    show('embedded-note', embedded);
    show('done-btn', embedded);
    if (cardsReady && !embedded && !stripe && window.Stripe) {
      stripe = window.Stripe(r.data.publishable_key);
      cardField = stripe.elements().create('card', { hidePostalCode: true });
      cardField.mount('#card-element');
    }
    const t = r.data.travel;
    $('t-first').value = t ? t.first_name : '';
    $('t-last').value = t ? t.last_name : '';
    $('t-gender').value = t ? t.gender : '';
    $('t-dob').value = t ? t.dob : '';
    $('t-irctc').value = t && t.irctc_user_id ? t.irctc_user_id : '';
    // A booking's one ask names what it still needs: those fields, and any the form must have that isn't kept yet.
    const wanted = Array.isArray(r.data.fields) ? r.data.fields : null;
    const must = { first_name: 't-first', last_name: 't-last', gender: 't-gender', dob: 't-dob' };
    document.querySelectorAll('#travel-form [data-field]').forEach((el) => {
      const name = el.dataset.field;
      el.hidden = !!wanted && !wanted.includes(name) && !(must[name] && !$(must[name]).value);
    });
    $('t-allow').checked = !!t;
    show('travel-delete', !!t);
    say('travel-used', t && t.last_used ? t.last_used : '');
    show('travel-used', !!(t && t.last_used));
    if (r.data.start === 'add_card') $(mode === 'demo' ? 'demo-card-form' : 'card-form').scrollIntoView();
    if (r.data.start === 'add_travel') $('travel').scrollIntoView();
  }

  async function saveTravel(ev) {
    ev.preventDefault();
    const allow = $('t-allow').checked;
    say('travel-msg', allow ? 'Saving' : 'Deleting');
    const r = await api('/travel', {
      first_name: $('t-first').value, last_name: $('t-last').value, gender: $('t-gender').value, dob: $('t-dob').value,
      irctc_user_id: $('t-irctc').value.trim() || null, allow,
    });
    if (!r.ok) { say('travel-msg', r.data.message || 'Not saved. Try again.', 'bad'); return; }
    say('travel-msg', r.data.saved ? 'Saved.' : 'Deleted. Tick the box to save them.', 'good');
    await home();
  }

  async function deleteTravel() {
    const r = await api('/travel/delete', {});
    if (!r.ok) { say('travel-msg', r.data.message || 'Not deleted. Try again.', 'bad'); return; }
    say('travel-msg', 'Deleted.', 'good');
    await home();
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
    if (v.data.session) session = v.data.session;
    await home();
  }

  // Demo cards (no Stripe keys): the typed number is matched here against the test cards, and the vault hears only which
  // one it is, never a number. Any other card is refused here, and could not be named to the vault either.
  const DEMO = { '4242424242424242': 'visa_4242', '4000000000000002': 'visa_decline' };
  const digits = (s) => String(s || '').replace(/\\D/g, '');

  function fillTestCard() {
    $('dc-number').value = '4242 4242 4242 4242';
    $('dc-exp').value = '12/' + String((new Date().getFullYear() + 3) % 100).padStart(2, '0');
    $('dc-cvv').value = '123';
    $('dc-name').value = 'Test Card';
    say('dc-msg', '');
  }

  async function saveDemoCard(ev) {
    ev.preventDefault();
    const card = DEMO[digits($('dc-number').value)];
    if (!card) { say('dc-msg', 'This demo takes test cards only. Use 4242 4242 4242 4242.', 'bad'); return; }
    const exp = /^(\\d{1,2})\\s*\\/\\s*(\\d{2})$/.exec($('dc-exp').value.trim());
    const month = exp ? Number(exp[1]) : 0;
    if (!exp || month < 1 || month > 12) { say('dc-msg', 'Check the expiry: MM/YY.', 'bad'); return; }
    if (!/^\\d{3,4}$/.test($('dc-cvv').value.trim())) { say('dc-msg', 'Check the CVV.', 'bad'); return; }
    say('dc-msg', 'Saving');
    const r = await api('/cards/demo', { card, exp_month: month, exp_year: 2000 + Number(exp[2]) });
    if (!r.ok) { say('dc-msg', r.data.message || 'The card was not saved.', 'bad'); return; }
    ['dc-number', 'dc-exp', 'dc-cvv', 'dc-name'].forEach((id) => { $(id).value = ''; });
    say('dc-msg', 'Card saved.', 'good');
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
    if (d.state !== 'ready') { $('gone-title').textContent = d.title || 'This link has expired'; say('gone-msg', d.message); show('gone'); tellApp('failed'); return; }
    $('amount').textContent = d.amount_label;
    $('merchant').textContent = d.merchant;
    $('purpose').textContent = d.purpose;
    if (d.refundable_label) { $('refund').textContent = d.refundable_label; show('refund'); }
    $('card').textContent = d.card_label;
    $('approve-btn').textContent = 'Approve with ' + (apple ? 'Face ID' : 'your passkey');
    demoPay = !!d.demo;
    show('pay-demo', demoPay);
    show('pay');
  }

  // The demo (no Stripe keys) asks for its bank code after Face ID, on its own screen, then pays.
  let demoPay = false;
  let signed = null;

  async function approve() {
    const btn = $('approve-btn');
    btn.disabled = true;
    say('pay-msg', '');
    const o = await api('/options', {});
    if (!o.ok) { say('pay-msg', o.data.message, 'bad'); return; }
    let response;
    try { response = await W.startAuthentication({ optionsJSON: o.data.options }); }
    catch (e) { say('pay-msg', 'Cancelled. Tap Approve to try again.', 'bad'); btn.disabled = false; return; }
    if (demoPay) {
      signed = { challenge_id: o.data.challenge_id, response };
      show('pay', false);
      show('otp');
      $('otp-code').focus();
      return;
    }
    say('pay-msg', 'Paying');
    await send({ challenge_id: o.data.challenge_id, response }, 'pay-msg');
  }

  async function sendOtp() {
    const code = $('otp-code').value.trim();
    if (code !== '123456') { say('otp-msg', "That code isn't right. The demo code is 123456.", 'bad'); return; }
    $('otp-btn').disabled = true;
    say('otp-msg', 'Paying');
    await send({ ...signed, otp: code }, 'otp-msg');
  }

  async function send(body, msgId) {
    try {
      const r = await api('/approve', body);
      if (r.data.state === 'paid') { show('pay', false); show('otp', false); show('done'); tellApp('saved'); return; }
      say(msgId, r.data.message || "The payment didn't go through.", r.data.state === 'confirming' ? '' : 'bad');
      if (r.data.retry) {
        // Face ID again, from the start.
        show('otp', false);
        show('pay');
        say('pay-msg', r.data.message || 'Try again.', 'bad');
        $('approve-btn').disabled = false;
        $('otp-btn').disabled = false;
      }
      // The bank is confirming: approved, and Go says when it is done. Refused for good, or failed: the App hears failed.
      else tellApp(r.data.state === 'confirming' ? 'saved' : 'failed');
    } catch (e) {
      say(msgId, 'Something went wrong. Check the card in Go before trying again.', 'bad');
      tellApp('failed');
    }
  }

  if (document.body.dataset.page === 'home') {
    $('register-btn').addEventListener('click', () => ceremony('register', 'register-msg'));
    $('unlock-btn').addEventListener('click', () => ceremony('unlock', 'unlock-msg'));
    $('travel-form').addEventListener('submit', saveTravel);
    $('travel-delete').addEventListener('click', deleteTravel);
    $('card-form').addEventListener('submit', saveCard);
    $('demo-card-form').addEventListener('submit', saveDemoCard);
    $('demo-fill').addEventListener('click', fillTestCard);
    $('done-btn').addEventListener('click', () => tellApp('saved'));
    home();
  } else {
    $('approve-btn').addEventListener('click', approve);
    $('otp-btn').addEventListener('click', sendOtp);
    show('close-btn', framed);
    $('close-btn').addEventListener('click', () => tellApp('cancelled'));
    pay();
  }
})();
`;
