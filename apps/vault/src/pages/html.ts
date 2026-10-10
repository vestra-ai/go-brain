const head = (title: string): string =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  `<meta name="color-scheme" content="light"><title>${title}</title>` +
  '<link rel="stylesheet" href="/static/vault.css"></head>';

const mark = '<div class="mark" aria-label="Go">Go</div>';

export function homePage(): string {
  return `${head('Your Go vault')}<body data-page="home"><main>
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
<p id="cards-not-ready" class="msg" data-tone="bad" hidden>Adding a card isn't ready yet. Try again later.</p></section>
<section id="travel" class="card"><h2>Your travel details</h2>
<p class="muted">For a ticket Go books for you when the trip's ixigo account has none of yours. Only Go's booking reads them, never the chat.</p>
<p id="travel-used" class="fine" hidden></p>
<form id="travel-form">
<label for="t-first">First and middle name as on your ID</label><input id="t-first" class="field" autocomplete="given-name" maxlength="40" required>
<label for="t-last">Last name as on your ID</label><input id="t-last" class="field" autocomplete="family-name" maxlength="40" required>
<label for="t-gender">Gender</label><select id="t-gender" class="field" required><option value="">Choose</option><option value="male">Male</option><option value="female">Female</option></select>
<label for="t-dob">Date of birth</label><input id="t-dob" class="field" type="date" autocomplete="bday" required>
<label class="tick-row"><input id="t-allow" type="checkbox"> Go can use these to book tickets for me</label>
<button class="primary" type="submit">Save</button> <button id="travel-delete" type="button" hidden>Delete</button>
<p id="travel-msg" class="msg" role="status"></p></form></section>
<section class="card"><h2>Who opened your vault</h2><ul id="log" class="list small"></ul></section>
</div>
</main><script src="/static/webauthn.js"></script><script src="https://js.stripe.com/v3/"></script><script src="/static/vault.js"></script></body></html>`;
}

export function payPage(): string {
  return `${head('Approve payment')}<body data-page="pay"><main>
<header class="top">${mark}<h1>Approve payment</h1></header>
<section id="loading" class="card"><p class="muted">Loading the payment</p></section>
<section id="gone" class="card" hidden><h2 id="gone-title">This link has expired</h2><p id="gone-msg" class="muted"></p></section>
<section id="pay" class="card" hidden>
<p class="amount" id="amount"></p><p class="merchant" id="merchant"></p><p class="muted" id="purpose"></p>
<p class="refund" id="refund" hidden></p>
<div class="row"><span class="muted">Card</span><span id="card"></span></div>
<button id="approve-btn" class="primary big">Approve with Face ID</button><p id="pay-msg" class="msg" role="status"></p>
<p class="fine">The group agreed to this first. It works once, for this amount only.</p></section>
<section id="done" class="card done" hidden><div class="tick" aria-hidden="true">&#10003;</div><h2>Paid</h2>
<p class="muted">Go is booking it now. You can close this page.</p></section>
</main><script src="/static/webauthn.js"></script><script src="/static/vault.js"></script></body></html>`;
}
