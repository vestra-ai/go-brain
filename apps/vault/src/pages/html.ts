const head = (title: string): string =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  `<meta name="color-scheme" content="light"><title>${title}</title>` +
  '<link rel="stylesheet" href="/static/vault.css"></head>';

const mark = '<div class="mark" aria-label="Go">Go</div>';

/** The App's origins on the body, for an embedded page's word to its parent when it is done (go-vault). */
const framing = (o: { origins: readonly string[] } | null, embedded: boolean): string =>
  o ? ` data-frame-origins="${o.origins.join(' ')}"${embedded ? ' data-display="embedded"' : ''}` : '';

/** embedded (rev 5 R8): inside the App, unlock only. No card or travel form: those stay in the browser sheet. */
export function homePage(embedded: { origins: readonly string[] } | null = null): string {
  return `${head('Your Go vault')}<body data-page="home"${framing(embedded, true)}><main>
<header class="top">${mark}<h1>Your vault</h1><p class="muted">Your cards, under your Face ID. The AI in your chat never sees them.</p></header>
<section id="loading" class="card"><p class="muted">Opening your vault</p></section>
<section id="expired" class="card" hidden><h2>This link has expired</h2><p class="muted">Open your vault again from Go: You, then My vault.</p></section>
<section id="register" class="card" hidden><h2>Set up Face ID</h2>
<p class="muted">Your vault opens only with your face or fingerprint. Nobody else in the group can open it.</p>
<button id="register-btn" class="primary">Set up Face ID</button><p id="register-msg" class="msg" role="status"></p></section>
<section id="unlock" class="card" hidden><h2>Unlock your vault</h2>
<button id="unlock-btn" class="primary">Unlock with Face ID</button><p id="unlock-msg" class="msg" role="status"></p></section>
<div id="open" hidden>
<section class="card"><h2>Cards</h2><ul id="cards" class="list"></ul><p id="cards-empty" class="muted">No card yet.</p>
<form id="card-form"><label for="card-element">Add a card</label><div id="card-element" class="field"></div>
<button class="primary" type="submit">Save card</button><p id="card-msg" class="msg" role="status"></p>
<p class="fine">Test cards only for now. Your card goes straight to the payment processor; the vault keeps only a token.</p></form>
<form id="demo-card-form" hidden><p class="demo-note">Demo build: no money moves. Use the test card 4242 4242 4242 4242.</p>
<button id="demo-fill" type="button" class="secondary">Fill test card</button>
<label for="dc-number">Card number</label><input id="dc-number" class="field" inputmode="numeric" autocomplete="off" maxlength="23" placeholder="4242 4242 4242 4242">
<div class="pair"><div><label for="dc-exp">Expiry</label><input id="dc-exp" class="field" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="MM/YY"></div>
<div><label for="dc-cvv">CVV</label><input id="dc-cvv" class="field" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="123"></div></div>
<label for="dc-name">Name on card</label><input id="dc-name" class="field" autocomplete="off" maxlength="60">
<button class="primary" type="submit">Save card</button><p id="dc-msg" class="msg" role="status"></p>
<p class="fine">Test cards only: 4242 4242 4242 4242 pays, 4000 0000 0000 0002 is declined. The number and CVV never leave this phone; the vault keeps the brand and the last four digits.</p></form>
<p id="cards-not-ready" class="msg" data-tone="bad" hidden>Cards can't be added yet on this vault.</p></section>
<section id="travel" class="card"><h2>Your travel details</h2>
<p class="muted">For a ticket Go books for you when the trip's ixigo account has none of yours. Only Go's booking reads them, never the chat.</p>
<p id="travel-used" class="fine" hidden></p>
<form id="travel-form">
<div data-field="first_name"><label for="t-first">First and middle name as on your ID</label><input id="t-first" class="field" autocomplete="given-name" maxlength="40" required></div>
<div data-field="last_name"><label for="t-last">Last name as on your ID</label><input id="t-last" class="field" autocomplete="family-name" maxlength="40" required></div>
<div data-field="gender"><label for="t-gender">Gender</label><select id="t-gender" class="field" required><option value="">Choose</option><option value="male">Male</option><option value="female">Female</option></select></div>
<div data-field="dob"><label for="t-dob">Date of birth</label><input id="t-dob" class="field" type="date" autocomplete="bday" required></div>
<div data-field="irctc_user_id"><label for="t-irctc">IRCTC user ID, for train tickets (optional)</label><input id="t-irctc" class="field" autocomplete="off" maxlength="35"></div>
<label class="tick-row"><input id="t-allow" type="checkbox"> Go can use these to book tickets for me</label>
<button class="primary" type="submit">Save</button> <button id="travel-delete" type="button" hidden>Delete</button>
<p id="travel-msg" class="msg" role="status"></p></form></section>
<p id="embedded-note" class="fine" hidden>To add a card or your travel details, open your vault from Go in the browser.</p>
<button id="done-btn" type="button" hidden>Done</button>
<section class="card"><h2>Who opened your vault</h2><ul id="log" class="list small"></ul></section>
</div>
</main><script src="/static/webauthn.js"></script><script src="https://js.stripe.com/v3/"></script><script src="/static/vault.js"></script></body></html>`;
}

/** framing: the App's origins, which may frame the page; it tells the App when it is done, whichever way it opened. */
export function payPage(framed: { origins: readonly string[] } | null = null): string {
  return `${head('Approve payment')}<body data-page="pay"${framing(framed, false)}><main>
<header class="top">${mark}<h1>Approve payment</h1></header>
<section id="loading" class="card"><p class="muted">Loading the payment</p></section>
<section id="gone" class="card" hidden><h2 id="gone-title">This link has expired</h2><p id="gone-msg" class="muted"></p></section>
<section id="pay" class="card" hidden>
<p id="pay-demo" class="demo-note" hidden>Demo build: no money moves.</p>
<p class="amount" id="amount"></p><p class="merchant" id="merchant"></p><p class="muted" id="purpose"></p>
<p class="refund" id="refund" hidden></p>
<div class="row"><span class="muted">Card</span><span id="card"></span></div>
<button id="approve-btn" class="primary big">Approve with Face ID</button><p id="pay-msg" class="msg" role="status"></p>
<button id="close-btn" type="button" hidden>Cancel</button>
<p class="fine">The group agreed to this first. It works once, for this amount only.</p></section>
<section id="otp" class="card" hidden><h2>Enter the code from your bank</h2>
<p class="demo-note">Demo OTP: 123456</p>
<label for="otp-code">One-time code</label><input id="otp-code" class="field" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
<button id="otp-btn" class="primary big">Pay</button><p id="otp-msg" class="msg" role="status"></p></section>
<section id="done" class="card done" hidden><div class="tick" aria-hidden="true">&#10003;</div><h2>Paid</h2>
<p class="muted">Go is booking it now. You can close this page.</p></section>
</main><script src="/static/webauthn.js"></script><script src="/static/vault.js"></script></body></html>`;
}
