# Operations

This page is for whoever runs Go this week. It says where Go runs, what each setting on each service is for, how to ship a new version, how to check it is healthy, how to run the live smoke, how to roll back, and how to flip the demo switches.

Two words used below:

- **Production** and **staging** are the two environments of the Railway project `go`. Production's Go is the one the real trip and the demo use. Staging runs the same services and takes every new version first, with the live smoke and the rehearsals; production is never used for drills.
- **A variable** is a setting on a Railway service. Values live only in Railway. Never paste a value into a chat, a doc, a commit or a log.

## The Railway project

Everything runs in the Railway project `go`, which has two environments, `staging` and `production`, in Railway's US East region (us-east4). Each environment has the same four services:

| Service | What it is | Built from |
|---|---|---|
| `brain` | Go. | `apps/brain/Dockerfile` |
| `Postgres` | Go's database. Only `brain` uses it, over Railway's private network (`postgres.railway.internal`). | Railway's Postgres template |
| `vault` | The vault: it keeps each payer's passkey and test card, and charges a payment once the Server and the payer both approved it. | Railpack, with the build and start commands in its variables |
| `Postgres-D6Kp` | The vault's own database. Only `vault` uses it; Go never reads it. | Railway's Postgres template |

Their public addresses:

| | `staging` | `production` |
|---|---|---|
| `brain` | https://brain-staging-e92c.up.railway.app | https://brain-production-6b68.up.railway.app |
| `vault` | https://vault-staging-9c77.up.railway.app | https://vault-production-35aa.up.railway.app |

The databases have no public address. Outbound calls leave from Railway's shared static IPs for US East, which is what ixigo allows: 162.220.234.240, 152.55.180.240, 152.55.180.241 and 152.55.180.243.

Go applies its database migrations itself when it starts, so a new version that needs a new table needs nothing extra.

The Supabase project `go` belongs to the Server team and holds nothing of Go's.

### Health checks and restarts

Each app service has a health check and a restart policy in its own Railway settings, in both environments:

| Service | Health check path | Timeout | Restart |
|---|---|---|---|
| `brain` | `/v1/health` | 60 s | on failure, up to 10 times |
| `vault` | `/health` | 60 s | on failure, up to 10 times |

Railway starts a new deploy, waits for the health check to answer, and only then moves traffic to it. A version that never becomes healthy fails its deploy and the old one keeps running. A setting changed on a service applies from that service's next deploy.

The settings live on the services, not in the repo: no service has a config file path set, so the `railway.json` files in `apps/brain` and `apps/vault` are not read. Keep them in step with the settings anyway, so the repo says what runs.

To change a setting, use the service's Settings, Deploy in the dashboard, or Railway's API (the `serviceInstanceUpdate` mutation), from the deploy worktree:

```bash
cd ~/workspace/agents/go-brain-worktrees/deploy
env=$(railway status --json | jq -r '.environments.edges[].node | select(.name=="production") | .id')
sid=$(railway status --json | jq -r '.environments.edges[].node | select(.name=="production") | .serviceInstances.edges[].node | select(.serviceName=="brain") | .serviceId')
railway api "mutation { serviceInstanceUpdate(environmentId: \"$env\", serviceId: \"$sid\", input: { healthcheckPath: \"/v1/health\", healthcheckTimeout: 60, restartPolicyType: ON_FAILURE, restartPolicyMaxRetries: 10 }) }"
```

To read them back, the same ids with a query:

```bash
railway api "query { serviceInstance(environmentId: \"$env\", serviceId: \"$sid\") { healthcheckPath healthcheckTimeout restartPolicyType restartPolicyMaxRetries } }"
```

## Variables

These are the names only. To read the names on a service, in one environment:

```bash
cd ~/workspace/agents/go-brain-worktrees/deploy
railway variables --service brain --environment production --json | jq -r 'keys[]'
```

Use `jq` to list the keys rather than cutting the `--kv` output at `=`: a value that runs over several lines, like a PEM key, would print.

In the tables, **Placeholder** means the variable holds a stand-in until Keshav's key arrives, and the feature that uses it does not work until then. **Not set** means the feature is off.

### brain

The table is production's `brain`. Staging's differences follow it.

| Variable | What it is for | State |
|---|---|---|
| `DATABASE_URL` | Go's database: the environment's own `Postgres`, as the reference `${{Postgres.DATABASE_URL}}`, over the private network. | Set |
| `GO_SIGNING_SECRET` | Signs the socket between the Server and Go. The Server holds the same value. | Set |
| `GO_PUBLIC_URL` | Go's own https address: the links to the pictures on Go's cards, and where Twilio connects a call's audio to Go. | Set |
| `GO_ROLE` | Which Go this is: `stage` in production, `rehearsal` in staging. The admin page shows it, and the rehearsal runner refuses any Go that is not `rehearsal`. Without it, Go falls back to Railway's service name. | Set: `stage` |
| `ANTHROPIC_API_KEY` | The model Go thinks with: every turn, the notes and the trip summary. | Set: Vestra's staging key |
| `COMPOSER_MODEL` | The model for Go's turns in the room. | Set |
| `SIDE_MODEL` | The smaller model for notes and summaries. | Set |
| `LOG_LEVEL` | How much Go writes to its log. | Set |
| `TRAVEL_MODE` | The start value of the `TRAVEL_MODE` switch. | Set |
| `PAY_RAIL` | The start value of the `PAY_RAIL` switch. | Set |
| `CALLS_MODE` | The start value of the `CALLS_MODE` switch. | Set |
| `VAULT_URL` | The vault's address. Money stays off until this and `VAULT_SHARED_SECRET` are both set. | Set |
| `VAULT_SHARED_SECRET` | Signs every call between Go and the vault, both ways. The vault holds the same value. | Set |
| `ADMIN_TOKEN` | Opens the admin page. | Set |
| `TYPESAFE_API_KEY` | Jev, the quick read of every message: is it for Go, does it hold a fact (the instant ✅). Without it Jev makes no calls, every quick read is "unsure", and Go decides from its own rules alone. | Set |
| `TYPESAFE_BASE_URL`, `JEV_MODEL`, `REFLEX_LIVE`, `JEV_DEADLINE_MS`, `JEV_DAILY_CALLS_PER_TRIP` | Jev's address, its pinned version, which questions act live, how long a message waits for it, and a daily cap per trip. | Not set: the defaults apply |
| `VESTRA_API_URL`, `VESTRA_API_KEYS`, `VESTRA_ADMIN_KEY`, `VESTRA_WEBHOOK_SECRET`, `VESTRA_DEPLOYMENT_ID`, `VESTRA_MCP_SERVER_ID` | The trip's computer through Vestra `/v1`: jobs like the villa search, and Watch. All six come from `scripts/setup-v1.ts` and work only together. | Set: staging `/v1`, the "Go stage (ixigo hackweek)" test org |
| `IXIGO_MCP_URL`, `IXIGO_MCP_TOKEN` | ixigo's search server and its token. Without them, searches use the test inventory even when `TRAVEL_MODE` says `ixigo`. | Not set |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Placing phone calls, and the number Go calls from. | Not set: Keshav's keys. Go refuses to call until they are in. |
| `OPENAI_API_KEY` | The voice model Go speaks with on a call. | Not set: Keshav's key |
| `CALLS_ALLOWLIST` | The only numbers Go may call this week, as `Name=+91...` joined by commas. | Not set |
| `CALLS_VOICE_MODEL` | The voice model on a call. | Not set: the default applies |
| `FOLD_AT_TOKENS`, `STORY_TOKENS`, `CHAT_HARD_CAP_TOKENS`, `NOTES_QUIET_MS`, `FOLD_QUIET_MS` | How long a chat grows before Go summarises it (right after Go posts, or after `FOLD_QUIET_MS` of quiet, at most 10 minutes in a busy chat), and how long Go waits after the last message before it takes notes. | Not set: the defaults apply |

Railway also sets `RAILWAY_*` variables on every service (its domains and ids). On `brain`, `RAILWAY_DOCKERFILE_PATH` picks the Dockerfile.

### brain in staging

The same variable names, with these differences:

- `DATABASE_URL` is staging's own `Postgres`.
- `GO_SIGNING_SECRET` and `ADMIN_TOKEN` are its own: production's secret does not open it, and its secret does not open production.
- `GO_ROLE` is `rehearsal`, so the rehearsal runner accepts it.
- `GO_PUBLIC_URL`, `VAULT_URL` and `VAULT_SHARED_SECRET` are staging's own address and staging's vault.
- The `VESTRA_*` variables point at its own test org on staging `/v1`, "Go rehearsal (ixigo hackweek)".

**It has its own vault.** Staging's `vault` reports every payment to staging's `brain` (its `GO_CALLBACK_URL`), so a payment approved on the vault page during a rehearsal reaches the Go that asked for it. Nothing staging pays touches production.

### vault

| Variable | What it is for | State |
|---|---|---|
| `VAULT_DATABASE_URL` | The vault's own database, the environment's `Postgres-D6Kp`. | Set |
| `VAULT_MASTER_KEY` | Encrypts what the vault stores. Changing it makes everything already stored unreadable. | Set |
| `GO_SPEND_PUBLIC_KEY` | The Server's public key. The vault pays only on an approval the Server signed with the matching private key. With the contract's test key, the vault refuses to start unless it pays on the fake rail only. | Set |
| `VAULT_SHARED_SECRET` | The same value as on `brain`. | Set |
| `VAULT_PUBLIC_URL` | The vault's own address, where the payer's phone opens the pay page. | Set |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | The domain and address passkeys are made for. A passkey only works on the domain it was made for, so changing these means every payer enrolls again. | Set |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | Stripe's test keys, for the test card. The vault refuses to start with a live key. | Placeholder: Keshav's keys |
| `GO_CALLBACK_URL` | Go's address (the same as `GO_PUBLIC_URL` on `brain`), where the vault reports a payment. | Set |
| `VAULT_RAILS` | Which rails the vault may pay on: `fake`, `stripe_test`, `ixigo`. | Set |
| `RAILPACK_BUILD_CMD`, `RAILPACK_START_CMD` | How Railway builds and starts the vault. | Set |

### vault in staging

The same variable names as production's `vault`, with these differences:

- `VAULT_DATABASE_URL` is staging's own `Postgres-D6Kp`.
- `VAULT_MASTER_KEY` and `VAULT_SHARED_SECRET` are its own; staging's `brain` holds the same shared secret.
- `VAULT_PUBLIC_URL`, `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID` are its own address, so a passkey made on production's vault does not work here: enroll again for a rehearsal.
- `GO_CALLBACK_URL` is staging's `brain`.

### The databases

Each environment has two Railway databases: `Postgres` for `brain` and `Postgres-D6Kp` for `vault`. Both have Railway's template variables: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `PGDATA`, `SSL_CERT_DAYS`. Leave them alone: `brain` and `vault` read their addresses from them.

## Deploy

Ship what is on `build`, from the deploy worktree, one service at a time, to staging first:

```bash
cd ~/workspace/agents/go-brain-worktrees/deploy
git fetch origin
git checkout --detach origin/build
git status --short          # railway up uploads the folder as it is on disk, so local edits would ship too
railway up --service brain --environment staging --detach -m "$(git rev-parse --short HEAD) $(git log -1 --format=%s)"
```

Use `--service vault` for the vault. Ship a new version to staging first, run the live smoke there, then ship the same commit with `--environment production`. The `-m` message puts the commit on the deployment, so the deployment list shows which commit is live.

Follow it:

```bash
railway logs --service brain --environment staging --build        # the build
railway logs --service brain --environment staging --deployment   # the running service
railway deployment list --service brain --environment staging --limit 5
```

A build takes a few minutes. Railway keeps the old version running until the new one has started.

## Check health

After every deploy, and before the demo:

```bash
curl -s https://brain-production-6b68.up.railway.app/v1/health   # {"ok":true,"contract":"1.0.0"}
curl -s https://brain-staging-e92c.up.railway.app/v1/health       # the same
curl -s https://vault-production-35aa.up.railway.app/health      # {"ok":true}
curl -s https://vault-staging-9c77.up.railway.app/health         # the same
```

`/v1/health` says Go is up and which contract it speaks. It does not check the model, Jev, `/v1`, ixigo or the vault. The admin page's health view checks each of those, at `/admin?token=...` and `/admin/health.json`.

## Run the live smoke

The live smoke checks that a deployed Go answers people in time. It connects to Go the way the Server does (as instance `smoke`), makes a new trip called "Smoke test ..." with a new trip id every run, waits for Go's hello, then says two lines as Priya:

1. "@Go hello, what can you do?"
2. "@Go flights Delhi to Goa Friday evening"

For each line it prints how long Go took to show typing, Go's reply, the cards Go posted, and the total time. It passes when typing shows within 1 second and a reply lands within 15 seconds on both lines.

Run it against staging, never production, from any worktree at `origin/build` after `pnpm install`:

```bash
GO_URL=https://brain-staging-e92c.up.railway.app railway run --service brain --environment staging -- pnpm --filter @go/sim live-smoke
```

`railway run` puts the service's variables, `GO_SIGNING_SECRET` among them, into the command's environment, so the secret never appears in your terminal or your shell history. The script reads `GO_URL` and `GO_SIGNING_SECRET` from the environment only. It exits 0 on a pass, 1 when typing was slow or a reply did not come, and 2 when it could not connect.

Things to know:

- Each run leaves one smoke trip in Go's database. When jobs are on, it also gets its own trip computer on Vestra. Run it a few times, never in a loop.
- The flights line searches whatever the `TRAVEL_MODE` switch says.

## Rehearse

The rehearsal runner plays the whole demo on staging's Go, times every beat against the run sheet, and refuses any Go whose role is not `rehearsal`. It reads `GO_REHEARSAL_URL`, `GO_SIGNING_SECRET`, `GO_ADMIN_TOKEN` and `GO_STAGE_URL` from the environment. The service calls its admin token `ADMIN_TOKEN`, so pass it on inside the command:

```bash
GO_REHEARSAL_URL=https://brain-staging-e92c.up.railway.app GO_STAGE_URL=https://brain-production-6b68.up.railway.app \
  railway run --service brain --environment staging -- sh -c 'GO_ADMIN_TOKEN="$ADMIN_TOKEN" pnpm --filter @go/bench rehearse'
```

The single quotes matter: the token is read inside the command's environment, never typed or shown. The only thing the runner does to production's Go is the warm-up before the demo (`--warm --trip <real trip id>`, with `--environment production` and `GO_STAGE_URL`): one health read, no trip and no message.

## Learn the idea places

The Server's ideas on the home screen ask Go `place_info`, which answers only from places Go has learned. To have the ideas' photos, map and best months ready before anyone looks, learn them ahead, once, on the Go that Server talks to, in your ixigo queue turn:

```bash
GO_URL=https://brain-staging-e92c.up.railway.app \
  railway run --service brain --environment staging -- sh -c 'GO_ADMIN_TOKEN="$ADMIN_TOKEN" pnpm --filter @go/sim learn-places'
```

It makes one new trip of its own (its own computer, no dates, so no stays search), waits a minute for the computer, then learns each place through that trip with `POST /admin/places/learn`: ixigo's place box once and its guide once or twice a place, one place every few seconds. It prints what `place_info` will answer for each and stops at the first refusal. A place ixigo's place box can't settle on (Kerala, Ladakh: many of its entries fit the word) is learned from ixigo's guide for the word alone, with photos and best months but no map position, and never becomes a trip's destination. A few of the Server's names ixigo knows only by other words are learned from its guide under those words and kept under the Server's name: Ladakh as Leh Ladakh, Andaman as Andaman and Nicobar (`IXIGO_WORDS` in `apps/brain/src/travel/place-info.ts`). A place neither knows is skipped. Name places after the command to learn only those. A place already learned loads nothing.

## Roll back

1. Find the last good version: the deployment list (`railway deployment list --service brain --environment production`) and its messages, or `git log origin/build`.
2. The fastest way: in the Railway dashboard, pick the environment, open the service, then Deployments, then the last good deployment's menu, then Rollback. Railway restores that deployment's build and its variables, so check the variables afterwards.
3. From the command line, deploy the good commit again:

   ```bash
   cd ~/workspace/agents/go-brain-worktrees/deploy
   git checkout --detach <good commit>
   railway up --service brain --environment production --detach -m "rollback to $(git rev-parse --short HEAD)"
   ```

4. Check health, and run the live smoke.

A rollback does not undo database migrations: Go only migrates forward. Older code runs on the newer database when the migration only added things. If a migration renamed or removed something, ship a fix forward instead of rolling back.

## The demo switches

Four switches change how Go behaves on stage without a redeploy. Go reads them on every use and picks up a change within 2 seconds.

| Switch | Values | What it does | When nothing sets it |
|---|---|---|---|
| `TRAVEL_MODE` | `ixigo`, `fake` | Where flights and stays come from. `fake` is our test inventory: say so on stage. | `fake` |
| `PAY_RAIL` | `ixigo`, `stripe_test`, `fake` | How a payment is charged. `stripe_test` charges a test card; `fake` charges nothing. | `fake` |
| `CALLS_MODE` | `off`, `allowlist` | Whether Go may phone anyone. `allowlist` means only the numbers in `CALLS_ALLOWLIST`. | `off` |
| `REFLEX_LIVE` | `off`, empty, or questions like `q1,q2,q3,q5,q7` | Which of Jev's quick-read questions act live; the others only watch. `off` makes no Jev call at all. | `q1,q2,q4,q5,q6,q7,q8,q10,q11` |

A switch takes the first of these that has a value:

1. The value set on the admin page (stored in Go's database, in the `switches` table).
2. The variable of the same name on that environment's `brain`.
3. The default in the table above.

To flip a switch:

- **On the admin page:** open `/admin?token=...`, pick the value, save. This is the way on stage.
- **Until then, in the database:** `railway connect Postgres --environment production`, then:

  ```sql
  insert into switches (name, value, updated_at) values ('TRAVEL_MODE', 'fake', now())
  on conflict (name) do update set value = excluded.value, updated_at = excluded.updated_at;
  ```

  To go back to the variable's value, remove the stored one: `delete from switches where name = 'TRAVEL_MODE';`
- **By changing the variable on that environment's `brain`.** This restarts Go, and a value stored on the admin page still wins over it.
