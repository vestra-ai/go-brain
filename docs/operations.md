# Operations

This page is for whoever runs Go this week. It says where Go runs, what each setting on each service is for, how to ship a new version, how to check it is healthy, how to run the live smoke, how to roll back, and how to flip the demo switches.

Two words used below:

- **The stage Go** is the `brain` service: the Go the real trip and the demo use.
- **A variable** is a setting on a Railway service. Values live only in Railway. Never paste a value into a chat, a doc, a commit or a log.

## The Railway project

Everything runs in the Railway project `go`, environment `production`.

| Service | What it is | Public address | Built from |
|---|---|---|---|
| `brain` | The stage Go. | https://brain-production-6b68.up.railway.app | `apps/brain/Dockerfile` |
| `vault` | The vault: it keeps each payer's passkey and test card, and charges a payment once the Server and the payer both approved it. | https://vault-production-35aa.up.railway.app | Railpack, with the build and start commands in its variables |
| `fake-go` | A stand-in for Go that the App and Server teams build and test against. It is not the stage Go. | https://fake-go-production.up.railway.app | `apps/fake-go/Dockerfile` |
| `Postgres` | Go's database. Only `brain` uses it. | none (private network only) | Railway's Postgres template |
| `Postgres-D6Kp` | The vault's own database. Only `vault` uses it; Go never reads it. | none (private network only) | Railway's Postgres template |
| `brain-rehearsal` | The rehearsal Go: the same code as `brain`, with its own database, its own signing secret and its own admin token. Rehearsals and the live smoke go here, never to the stage. | https://brain-rehearsal-production.up.railway.app | `apps/brain/Dockerfile` |
| `Postgres-ozV9` | `brain-rehearsal`'s database. | none (private network only) | Railway's Postgres template |
| `vault-rehearsal` | The rehearsal vault: the same code as `vault`, with its own database, master key and shared secret. It reports payments to `brain-rehearsal`, so a rehearsal can pay end to end. | https://vault-rehearsal-production.up.railway.app | Railpack, with the build and start commands in its variables |
| `Postgres-hxd7` | `vault-rehearsal`'s database. | none (private network only) | Railway's Postgres template |

Go applies its database migrations itself when it starts, so a new version that needs a new table needs nothing extra.

### Health checks and restarts

Each app service has a health check and a restart policy in its own Railway settings:

| Service | Health check path | Timeout | Restart |
|---|---|---|---|
| `brain`, `brain-rehearsal`, `fake-go` | `/v1/health` | 60 s | on failure, up to 10 times |
| `vault`, `vault-rehearsal` | `/health` | 60 s | on failure, up to 10 times |

Railway starts a new deploy, waits for the health check to answer, and only then moves traffic to it. A version that never becomes healthy fails its deploy and the old one keeps running. A setting changed on a service applies from that service's next deploy.

The settings live on the services, not in the repo: no service has a config file path set, so the `railway.json` files in `apps/brain`, `apps/vault` and `apps/fake-go` are not read. Keep them in step with the settings anyway, so the repo says what runs.

To change a setting, use the service's Settings, Deploy in the dashboard, or Railway's API (the `serviceInstanceUpdate` mutation), from the deploy worktree:

```bash
cd ~/workspace/agents/go-brain-worktrees/deploy
env=$(railway status --json | jq -r '.environments.edges[0].node.id')
sid=$(railway status --json | jq -r '.environments.edges[].node.serviceInstances.edges[].node | select(.serviceName=="brain") | .serviceId')
railway api "mutation { serviceInstanceUpdate(environmentId: \"$env\", serviceId: \"$sid\", input: { healthcheckPath: \"/v1/health\", healthcheckTimeout: 60, restartPolicyType: ON_FAILURE, restartPolicyMaxRetries: 10 }) }"
```

To read them back, the same ids with a query:

```bash
railway api "query { serviceInstance(environmentId: \"$env\", serviceId: \"$sid\") { healthcheckPath healthcheckTimeout restartPolicyType restartPolicyMaxRetries } }"
```

## Variables

These are the names only. To read the names on a service:

```bash
cd ~/workspace/agents/go-brain-worktrees/deploy
railway variables --service brain --json | jq -r 'keys[]'
```

Use `jq` to list the keys rather than cutting the `--kv` output at `=`: a value that runs over several lines, like a PEM key, would print.

In the tables, **Placeholder** means the variable holds a stand-in until Keshav's key arrives, and the feature that uses it does not work until then. **Not set** means the feature is off.

### brain

| Variable | What it is for | State |
|---|---|---|
| `DATABASE_URL` | Go's database, from the `Postgres` service. | Set |
| `GO_SIGNING_SECRET` | Signs the socket between the Server and Go. The Server holds the same value. It is not the same as `fake-go`'s. | Set |
| `GO_PUBLIC_URL` | Go's own https address: the links to the pictures on Go's cards, and where Twilio connects a call's audio to Go. | Set |
| `GO_ROLE` | Which Go this is: `stage` here, `rehearsal` on `brain-rehearsal`. The admin page shows it, and the rehearsal runner refuses any Go that is not `rehearsal`. Without it, Go falls back to Railway's service name. | Set |
| `ANTHROPIC_API_KEY` | The model Go thinks with: every turn, the notes and the trip summary. | Placeholder: Go cannot answer anyone until the real key is in. |
| `COMPOSER_MODEL` | The model for Go's turns in the room. | Set |
| `SIDE_MODEL` | The smaller model for notes and summaries. | Set |
| `LOG_LEVEL` | How much Go writes to its log. | Set |
| `TRAVEL_MODE` | The start value of the `TRAVEL_MODE` switch. | Set |
| `PAY_RAIL` | The start value of the `PAY_RAIL` switch. | Set |
| `CALLS_MODE` | The start value of the `CALLS_MODE` switch. | Set |
| `VAULT_URL` | The vault's address. Money stays off until this and `VAULT_SHARED_SECRET` are both set. | Set |
| `VAULT_SHARED_SECRET` | Signs every call between Go and the vault, both ways. The vault holds the same value. | Set |
| `ADMIN_TOKEN` | Opens the admin page. | Set |
| `TYPESAFE_API_KEY` | Jev, the quick read of every message: is it for Go, does it hold a fact (the instant ✅). Without it Jev makes no calls, every quick read is "unsure", and Go decides from its own rules alone. | Not set: Keshav's key |
| `TYPESAFE_BASE_URL`, `JEV_MODEL`, `REFLEX_LIVE`, `JEV_DEADLINE_MS`, `JEV_DAILY_CALLS_PER_TRIP` | Jev's address, its pinned version, which questions act live, how long a message waits for it, and a daily cap per trip. | Not set: the defaults apply |
| `VESTRA_API_URL`, `VESTRA_API_KEYS`, `VESTRA_ADMIN_KEY`, `VESTRA_WEBHOOK_SECRET`, `VESTRA_DEPLOYMENT_ID`, `VESTRA_MCP_SERVER_ID` | The trip's computer through Vestra `/v1`: jobs like the villa search, and Watch. All six come from `scripts/setup-v1.ts` and work only together. | Not set: jobs are off |
| `IXIGO_MCP_URL`, `IXIGO_MCP_TOKEN` | ixigo's search server and its token. Without them, searches use the test inventory even when `TRAVEL_MODE` says `ixigo`. | Not set |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Placing phone calls, and the number Go calls from. | Not set: Keshav's keys. Go refuses to call until they are in. |
| `OPENAI_API_KEY` | The voice model Go speaks with on a call. | Not set: Keshav's key |
| `CALLS_ALLOWLIST` | The only numbers Go may call this week, as `Name=+91...` joined by commas. | Not set |
| `CALLS_VOICE_MODEL` | The voice model on a call. | Not set: the default applies |
| `FOLD_AT_TOKENS`, `STORY_TOKENS`, `CHAT_HARD_CAP_TOKENS`, `NOTES_QUIET_MS`, `FOLD_QUIET_MS` | How long a chat grows before Go summarises it (right after Go posts, or after `FOLD_QUIET_MS` of quiet, at most 10 minutes in a busy chat), and how long Go waits after the last message before it takes notes. | Not set: the defaults apply |

Railway also sets `RAILWAY_*` variables on every service (its domains and ids). On `brain` and `fake-go`, `RAILWAY_DOCKERFILE_PATH` picks the Dockerfile.

### brain-rehearsal

The same variable names as `brain`, with these differences:

- `DATABASE_URL` is `Postgres-ozV9`, not Go's stage database.
- `GO_SIGNING_SECRET` and `ADMIN_TOKEN` are its own: the stage's secret does not open it, and its secret does not open the stage.
- `GO_ROLE` is `rehearsal`.
- `VAULT_URL` and `VAULT_SHARED_SECRET` point at `vault-rehearsal`, not the stage's vault.
- `ANTHROPIC_API_KEY` is the same placeholder as on `brain` until Keshav's key arrives.

**It has its own vault.** `vault-rehearsal` reports every payment to `brain-rehearsal` (its `GO_CALLBACK_URL`), so a payment approved on the vault page during a rehearsal reaches the Go that asked for it. Nothing a rehearsal pays touches the stage's vault or the stage Go.

### vault

| Variable | What it is for | State |
|---|---|---|
| `VAULT_DATABASE_URL` | The vault's own database, from `Postgres-D6Kp`. | Set |
| `VAULT_MASTER_KEY` | Encrypts what the vault stores. Changing it makes everything already stored unreadable. | Set |
| `GO_SPEND_PUBLIC_KEY` | The Server's public key. The vault pays only on an approval the Server signed with the matching private key. With the contract's test key, the vault refuses to start unless it pays on the fake rail only. | Set |
| `VAULT_SHARED_SECRET` | The same value as on `brain`. | Set |
| `VAULT_PUBLIC_URL` | The vault's own address, where the payer's phone opens the pay page. | Set |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | The domain and address passkeys are made for. A passkey only works on the domain it was made for, so changing these means every payer enrolls again. | Set |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | Stripe's test keys, for the test card. The vault refuses to start with a live key. | Placeholder: Keshav's keys |
| `GO_CALLBACK_URL` | Go's address (the same as `GO_PUBLIC_URL` on `brain`), where the vault reports a payment. | Set |
| `VAULT_RAILS` | Which rails the vault may pay on: `fake`, `stripe_test`, `ixigo`. | Set |
| `RAILPACK_BUILD_CMD`, `RAILPACK_START_CMD` | How Railway builds and starts the vault. | Set |

### vault-rehearsal

The same variable names as `vault`, with these differences:

- `VAULT_DATABASE_URL` is `Postgres-hxd7`.
- `VAULT_MASTER_KEY` and `VAULT_SHARED_SECRET` are its own; `brain-rehearsal` holds the same shared secret.
- `VAULT_PUBLIC_URL`, `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID` are its own address, so a passkey made on the stage's vault does not work here: enroll again for a rehearsal.
- `GO_CALLBACK_URL` is `brain-rehearsal`'s address.
- `GO_SPEND_PUBLIC_KEY`, the Stripe keys, `VAULT_RAILS` and the Railpack commands are the same as on `vault`.

### fake-go

| Variable | What it is for | State |
|---|---|---|
| `GO_SIGNING_SECRET` | fake-go's own signing secret, the one the App and Server teams use in their tests. It does not open the stage Go. | Set |
| `FAKE_GO_ADMIN_TOKEN` | Opens fake-go's admin routes. | Set |
| `FAKE_GO_PUBLIC_URL` | fake-go's address for the links it hands out. Railway's domain is used when it is not set. | Not set |

### The databases: Postgres, Postgres-D6Kp, Postgres-ozV9, Postgres-hxd7

All four have Railway's template variables: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `PGDATA`, `SSL_CERT_DAYS`. Leave them alone: each Go and each vault reads its address from them.

## Deploy

Ship what is on `build`, from the deploy worktree, one service at a time:

```bash
cd ~/workspace/agents/go-brain-worktrees/deploy
git fetch origin
git checkout --detach origin/build
git status --short          # railway up uploads the folder as it is on disk, so local edits would ship too
railway up --service brain --detach -m "$(git rev-parse --short HEAD) $(git log -1 --format=%s)"
```

Use `--service brain-rehearsal`, `--service vault`, `--service vault-rehearsal` or `--service fake-go` for the others. Ship a new Go to `brain-rehearsal` first, run the live smoke there, then ship the same commit to `brain`. The `-m` message puts the commit on the deployment, so the deployment list shows which commit is live.

Follow it:

```bash
railway logs --service brain --build        # the build
railway logs --service brain --deployment   # the running service
railway deployment list --service brain --limit 5
```

A build takes a few minutes. Railway keeps the old version running until the new one has started.

## Check health

After every deploy, and before the demo:

```bash
curl -s https://brain-production-6b68.up.railway.app/v1/health     # {"ok":true,"contract":"1.0.0"}
curl -s https://brain-rehearsal-production.up.railway.app/v1/health   # the same
curl -s https://vault-production-35aa.up.railway.app/health        # {"ok":true}
curl -s https://vault-rehearsal-production.up.railway.app/health  # the same
curl -s https://fake-go-production.up.railway.app/v1/health        # {"ok":true,"contract":"1.0.0"}
```

`/v1/health` says Go is up and which contract it speaks. It does not check the model, Jev, `/v1`, ixigo or the vault. The admin page's health view checks each of those, at `/admin?token=...` and `/admin/health.json`.

## Run the live smoke

The live smoke checks that a deployed Go answers people in time. It connects to Go the way the Server does (as instance `smoke`), makes a new trip called "Smoke test ..." with a new trip id every run, waits for Go's hello, then says two lines as Priya:

1. "@Go hello, what can you do?"
2. "@Go flights Delhi to Goa Friday evening"

For each line it prints how long Go took to show typing, Go's reply, the cards Go posted, and the total time. It passes when typing shows within 1 second and a reply lands within 15 seconds on both lines.

Run it against `brain-rehearsal`, from any worktree at `origin/build` after `pnpm install`:

```bash
GO_URL=https://brain-rehearsal-production.up.railway.app railway run --service brain-rehearsal -- pnpm --filter @go/sim live-smoke
```

`railway run` puts the service's variables, `GO_SIGNING_SECRET` among them, into the command's environment, so the secret never appears in your terminal or your shell history. The script reads `GO_URL` and `GO_SIGNING_SECRET` from the environment only. It exits 0 on a pass, 1 when typing was slow or a reply did not come, and 2 when it could not connect.

Things to know:

- Each run leaves one smoke trip in Go's database. When jobs are on, it also gets its own trip computer on Vestra. Run it a few times, never in a loop.
- The flights line searches whatever the `TRAVEL_MODE` switch says.
- While `ANTHROPIC_API_KEY` is a placeholder, Go cannot reply, so the smoke fails with "no reply".
- Smoke the stage Go (`GO_URL` set to `brain`'s address, `--service brain`) only when you must, and only after the real trip has had a message since Go last started. Go sends each trip's requests back on the socket that brought that trip's events, so the real trip stays on the real Server's socket. But right after a restart, before the real trip has had any event, a request for the real trip can go to the smoke's socket instead and fail.

## Rehearse

The rehearsal runner plays the whole demo on `brain-rehearsal`, times every beat against the run sheet, and refuses any Go whose role is not `rehearsal`. It reads `GO_REHEARSAL_URL`, `GO_SIGNING_SECRET`, `GO_ADMIN_TOKEN` and `GO_STAGE_URL` from the environment. The service calls its admin token `ADMIN_TOKEN`, so pass it on inside the command:

```bash
GO_REHEARSAL_URL=https://brain-rehearsal-production.up.railway.app GO_STAGE_URL=https://brain-production-6b68.up.railway.app \
  railway run --service brain-rehearsal -- sh -c 'GO_ADMIN_TOKEN="$ADMIN_TOKEN" pnpm --filter @go/bench rehearse'
```

The single quotes matter: the token is read inside the command's environment, never typed or shown. The only thing the runner does to the stage Go is the warm-up before the demo (`--warm --trip <real trip id>`, with `--service brain` and `GO_STAGE_URL`): one health read, no trip and no message.

## Roll back

1. Find the last good version: the deployment list (`railway deployment list --service brain`) and its messages, or `git log origin/build`.
2. The fastest way: in the Railway dashboard, open the service, then Deployments, then the last good deployment's menu, then Rollback. Railway restores that deployment's build and its variables, so check the variables afterwards.
3. From the command line, deploy the good commit again:

   ```bash
   cd ~/workspace/agents/go-brain-worktrees/deploy
   git checkout --detach <good commit>
   railway up --service brain --detach -m "rollback to $(git rev-parse --short HEAD)"
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
| `REFLEX_LIVE` | `off`, empty, or questions like `q1,q2,q3,q5,q7` | Which of Jev's quick-read questions act live; the others only watch. `off` makes no Jev call at all. | `q1,q4,q5,q6,q7,q8` |

A switch takes the first of these that has a value:

1. The value set on the admin page (stored in Go's database, in the `switches` table).
2. The variable of the same name on `brain`.
3. The default in the table above.

To flip a switch:

- **On the admin page:** open `/admin?token=...`, pick the value, save. This is the way on stage.
- **Until then, in the database:** `railway connect Postgres`, then:

  ```sql
  insert into switches (name, value, updated_at) values ('TRAVEL_MODE', 'fake', now())
  on conflict (name) do update set value = excluded.value, updated_at = excluded.updated_at;
  ```

  To go back to the variable's value, remove the stored one: `delete from switches where name = 'TRAVEL_MODE';`
- **By changing the variable on `brain`.** This restarts Go, and a value stored on the admin page still wins over it.
