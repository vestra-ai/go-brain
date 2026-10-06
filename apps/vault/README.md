# apps/vault: the vault

The vault holds each person's card and makes payments. It is its own service with its own database and its own master key, separate from Go's service. The model never sees a card: a card is added on the vault's page through the payment processor's own form, and the vault keeps only the processor's token for it, encrypted. A payment needs two keys: the Server's signed spend approval and the payer's own passkey (Face ID or a fingerprint) on the vault's page. Neither key is the model's word.

It is a Fastify service on Node 22 with Postgres 16. It takes Stripe test keys only and refuses to start with a live key. It also refuses to start with the contract's public test spend key unless it pays on the fake rail only (`VAULT_RAILS=fake`), because anyone can sign approvals with that key. Its settings are checked at boot in [`src/env.ts`](src/env.ts). A failed request is logged by its route, never by its path, because link tokens travel in paths.

## Main parts (under `src/`)

| Part | What it does |
|---|---|
| `internal/` | The only calls Go makes to the vault, each signed with `VAULT_SHARED_SECRET` (the same signing format as the socket, its own secret, each signature accepted once): `POST /internal/links` opens a short link to a person's vault home, `POST /internal/pay-links` opens a link to a pay page for one approved payment, `POST /internal/pay-links/void` stops every pay link for an approval Go let go, and `GET /internal/both-keys` counts payments without both keys from the vault's own records. |
| `pages/` | The pages a person opens from the App: the vault home (`/l/:token`), where they make a passkey, unlock, and add a card through Stripe's form; and the pay page (`/p/:token`), which shows what the Server approved and pays after the passkey. Links last 5 minutes and work once. |
| `pay.ts` | The payment, step by step, refusing at the first step that fails: the link is valid and unused; the passkey assertion verifies and belongs to the payer; the Server's Ed25519 signature checks and the approval has not expired; it is meant for the vault (`aud: go-vault`) by the Server (`iss: server`) for this trip; it was never used before (one row per `jti`, so two pages racing pay once); the payer the Server approved is the person who unlocked; and the amount is within the approval, in the same currency, while the hold still stands. Every attempt is logged with which keys passed. |
| `charge.ts` and `rails/` | The charge itself, once per approval, with the approval's `jti` as the idempotency key. `stripe_test` charges a saved test card through Stripe test mode, off session; `fake` moves no money; `ixigo` answers "not ready". When the rail gives no clear answer (a connection error, an unclear status), the payment is never settled as failed: it stays "charging", the page says the payment is being confirmed, and the sweep asks the rail again with the same `jti`. After 20 unclear answers or an hour, it is marked unknown for a person to check. |
| `go-callback.ts` | Tells Go the outcome (`/internal/vault/paid` or `/internal/vault/failed`), signed, and sends `/internal/vault/confirming` when a charge has no clear answer yet. A sweep sends it again, up to 50 times, until Go takes it; only a `400`, `409` or `422` from Go stops it sooner, and that is recorded apart from a delivered outcome. |
| `passkeys.ts` | WebAuthn registration and unlock, with challenges that last 2 minutes and work once. |
| `crypto/envelope.ts` | Envelope encryption for each stored card token: a random data key per item, wrapped by the master key, tied to the person and the item, so a copied row does not open. |
| `store/` | People, their Stripe customer and cards (only the sealed token, the brand, the last four digits and the expiry), and the log of every unlock and payment attempt. |
| `testing/` | A test vault, a fake Stripe, a software passkey authenticator and pay fixtures, for this app's tests and for other apps' end-to-end tests. |

## How the tests prove it

CI runs every test against a real Postgres; Stripe is a fake that behaves like test mode, and the passkey is a software authenticator.

- `pay.test.ts` walks every step above: a payment with both keys pays once, records the attempt and tells Go, signed; each step refuses on its own (a used or expired link, a failed passkey, an approval changed after signing, for another trip, already used, for another payer, over the amount, in another currency, or with the hold about to run out); two links racing pay once; and the card token never reaches a log line.
- `crypto/envelope.test.ts`: a sealed item opens only with its own master key, person and item; a flipped byte or a row copied to another person never opens.
- `go-callback.test.ts`: a charge with no clear answer stays charging, is asked again with the same key, charges once and Go hears "paid" once; after 20 unclear answers or an hour it is marked unknown, never failed.
- `env.test.ts`: the vault refuses live Stripe keys, a rail it does not know and wrong settings at boot.
- `passkeys.test.ts`, `pages/routes.test.ts`, `internal/routes.test.ts`, `rails/rails.test.ts`, `store/cards.test.ts` and `app.test.ts` cover the passkey, the pages, Go's signed calls, the rails, the stored cards and the error log.

`pnpm --filter @go/vault test` runs them (it needs `DATABASE_URL`).
