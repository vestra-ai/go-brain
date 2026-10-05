# P3: the replay bench and the proof board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove with numbers, on every push and live on stage, that Go is fast, quiet, cache-first and remembers: a replay bench that runs recorded group chats through the real Go in CI, a live bench with the real models, and a proof board that shows the numbers from real turns.

**Architecture:** `packages/bench` (`@go/bench`) holds the recorded chats (JSONL, one line per message, with labels), a seeded generator for the long chats, a cache estimator that reads the exact request bodies Go sends and computes the hit rate the provider would give, a scripted policy model and a label reflex so the fast bench needs no keys, a scorer, the bars and a report. The fast bench boots Go in-process with P1's `start()` against the CI Postgres and P0's `FakeServer`, replays each chat with idle time cut, and fails CI on a regression. `apps/brain/src/stats/` computes the board numbers from `turns` (plus a small source registry other lanes add to) and serves `/stats.json` and `/board`.

**Tech Stack:** Node 22, TypeScript strict (`exactOptionalPropertyTypes`), zod 4.3.6, vitest 4, Fastify 5, `pg` 8 (Postgres 16), `@anthropic-ai/sdk` 0.93.0 (live bench only), `@vestra/agent-sdk` (`computeAnthropicCostUsd`), `@go/contract`, `@go/sim` (P0), `@go/brain` (P1), GitHub Actions.

**Spec:** `docs/spec/2026-10-05-go-design.md` §1 (the bars, in numbers) and §17 (testing and proof: the replay bench), with §9 (context, cache-first) as the thing the bench checks, and `docs/plans/2026-10-05-go-the-week.md` (master plan; sections 6 and 7 are binding).

**Lane / gate:** Lane B. **G2, Tue 23:00:** the bench runs the 50 and 300 message chats in CI with numbers (Tasks 1 to 7 and 10). **G5, Thu 23:00:** the bars from spec §1 green on the live bench (Task 11), and the proof board on its URL for the 4:30 demo beat (Tasks 8 and 9).

**Depends on:**
- Master §6.6 `turns` columns (`turn_id`, `trip_id`, `woke_for`, `started_at`, `typing_at`, `first_token_at`, `posted_at`, `model`, `input_tokens`, `cached_tokens`, `output_tokens`, `cost_usd`, `outcome`, `error`), plus `trip_events`, `desk_items`, `go_requests`.
- Master §6.3 `Brain` (`env`, `pool`, `http`, `now`, `log`, `reflex`, `memory?`), `Reflex.read`, `ReflexRead`, `Memory.recall(tripId, question, audience)`, `RegisterLane`.
- Master §6.5 prompt layout: breakpoint 1 on the system block, breakpoint 2 on the last full chat chunk in the first user message, chat lines written `#seq Name: text`, the `stay_silent` tool.
- P1: `start(env: Env, overrides?: { anthropic?: AnthropicLike; now?: () => Date }): Promise<{ app: FastifyInstance; brain: Brain; stop(): Promise<void>; url: string }>` from `apps/brain/src/main.ts`; `withSchema()` from `apps/brain/src/db/test-db.ts` (returns `{ pool, drop }`); the env parser in `apps/brain/src/env.ts` (assumed name `loadEnv`, see Interface notes).
- P0: `@go/sim` `FakeServer` (`createTrip`, `say`, `tap`, `waitFor`, `writes`, `countWrites`) and `goaTrip()`. Only `packages/bench/src/sim-port.ts` touches it.
- P2 (optional at G2, required at G5): `brain.memory`, the fold.

**Parallel work:** Tasks 8 and 9 (`apps/brain/src/stats/`) share no file with Tasks 1 to 7 (`packages/bench/`). A second builder may take them at the same time. Task 10 needs both.

## Global Constraints

All of master §7 applies. Plan-specific, one line each:

- The fast bench never needs a key: the model is `PolicyModel` (Task 5) and the reflex is `BenchReflex` (Task 5). Real models and real Jev run only in `bench-live.yml` (`workflow_dispatch` and a nightly cron), never on push.
- Two clocks, each for one job: latencies use the wall clock (`Date.now()`) at both ends; the cache TTL uses chat time (the `at` offsets). Never mix them.
- Replay cuts idle time only: a gap of 3 s or less between lines is replayed in real time (so the desk's 2 s wait and bursts behave as in life); a longer gap becomes "wait until Go is quiet".
- The cache estimate follows the provider's rules from `research/agent-sdk.md` §3.4: render order tools, system, messages; a read lands only where an earlier request wrote a breakpoint; each breakpoint looks back at most 20 blocks; minimum cacheable prefix 512 tokens on Sonnet 5.5, 4,096 on Haiku 4.5, 1,024 otherwise; TTL from `cache_control.ttl` (`1h` = 3,600 s, else 300 s).
- Tokens in the estimate are `ceil(utf8 bytes of the block's canonical JSON / 4)`. Every number from it is labelled "estimate".
- The bench's cache bar uses every composer request except the run's very first (the one cold start of the rules a running service pays once, not per trip). The rules prefix (breakpoint 1) is treated as warm across TTL gaps, as other trips keep it warm in production.
- No NaN, `undefined` or `Infinity` in any report or page: a number with no data is `null` and reads "no data yet", "no turns yet", "not cacheable yet" or "no messages from people".
- The board is closed unless `ADMIN_TOKEN` is set (503), needs `?token=` (401 otherwise, compared in constant time), sends `Referrer-Policy: no-referrer` so the token never reaches the font CDN, and never names a model or its vendor.
- No em dashes in the board page, the bench summary, Go's scripted replies or chat labels.
- Bench output goes to `packages/bench/out/` (git-ignored); CI uploads it and appends the summary to the job page.

## Review Focus

1. **A delete inside the cached part of the chat.** The estimate must show the cache miss with reason `delete` (never hide it as a hit or blame "drift"), and the deleted text must never appear in a prompt sent more than a second after the delete. Tests: Task 4 (`delete inside the cached part`), Task 6 (`deleted text in a later prompt is a leak`), the `goa-300` skeleton's late delete (Task 3) run by Task 10. Master §10 item 5 (deletes vanish from the next prompt) is checked end to end here.
2. **Compressed time and clock skew.** A two-hour quiet gap replays in milliseconds but must still expire the 1 h cache (reason `ttl`), and a simulator that stamps frames with a fake clock must fail loudly instead of producing negative or huge latencies. Tests: Task 4 (`a quiet gap past the TTL`), Task 10 (`planReplay cuts idle time but keeps chat time`), Task 6 (`a frame stamped by another clock fails`).
3. **A young trip below the cache minimum.** On Haiku 4.5 a prompt under 4,096 tokens cannot be cached; the bench and the board say "not cacheable yet", never 0% and never a silent pass. Tests: Task 4 (`below the minimum`), Task 7 (`not cacheable yet passes with a note`), Task 8 (`only small Haiku turns`).
4. **Nothing to count.** The board before any turn, a chat with only Go's lines, a window with no people's messages: every number reads as a plain phrase, never NaN. Tests: Task 6 (`a chat with only Go's lines`), Task 8 (`an empty window`), Task 9 (`the board before any turn`).
5. **Bursts and double posts.** Five quick messages get one answer; a resend with the same `request_id` is one post, not two; the same text posted twice with nothing new in between is a duplicate and fails CI. Tests: Task 6 (`a resend with the same request_id is one post`, `the same text twice is a duplicate`), Task 2 (the burst in `goa-50`), Task 10 (the replay of `goa-50`). Master §10 item 2 (a burst while a turn runs) is checked end to end here.

## File Structure

`packages/bench/` (new package `@go/bench`):
- `package.json`: the package, scripts `build`, `typecheck`, `test`, `gen-chats`, `bench:fast`, `bench:live`.
- `tsconfig.json`: extends the base; builds `src/` without tests.
- `vitest.config.ts`: test files and the default timeout.
- `.gitignore`: ignores `out/`.
- `bars.json`: the bars the bench is judged on (fast and live).
- `chats/goa-50.jsonl`: the hand-written, hand-labelled 50-message Goa chat.
- `chats/goa-300.jsonl`: generated from the 300 skeleton, committed.
- `chats/goa-2000.jsonl`: generated from the 2,000 skeleton, committed.
- `scripts/gen-chats.ts`: writes the two generated chats.
- `src/index.ts`: the package's exports.
- `src/chat.ts`: the line schema, the loader, the checks, `addressesGo`, chat counts.
- `src/generate.ts`: the seeded random source, the filler bank, `expandSkeleton`, `serializeChat`.
- `src/skeletons/goa-300.ts`: the 300 chat's hand-written key lines.
- `src/skeletons/goa-2000.ts`: the 2,000 chat's hand-written key lines (a week, facts early, probes after the folds).
- `src/requests.ts`: recorded request bodies, the request log, blocks into positions, prompt size by part.
- `src/cache-estimate.ts`: the cache estimator, per-turn results with miss reasons, the cache summary.
- `src/policy-model.ts`: the scripted policy model (a fake Anthropic client).
- `src/recorder.ts`: a recording wrapper around the real Anthropic client (live bench).
- `src/bench-reflex.ts`: the label reflex, the recorded-Jev reflex, the counting wrapper, recording files.
- `src/stats-math.ts`: percentiles.
- `src/score.ts`: scores one replay (speak, quiet, latency, wake, cache, prompt, recall, leaks, cost).
- `src/compare.ts`: loads `bars.json`, judges fast and live results, picks a model.
- `src/report-md.ts`: the markdown summary and report writer.
- `src/sim-port.ts`: the only file that knows `@go/sim`'s `FakeServer` API.
- `src/replay.ts`: `planReplay` and `replayChat` (boots Go, replays, waits for quiet, runs recall probes).
- `src/run-fast.ts`: the fast bench (function and command line).
- `src/run-live.ts`: the live bench (command line).
- `src/__tests__/chat.test.ts`, `goa-50.test.ts`, `generate.test.ts`, `cache-estimate.test.ts`, `stand-ins.test.ts`, `score.test.ts`, `compare.test.ts`, `fast-bench.test.ts`, `live.test.ts`.

`apps/brain/` (P3's folder `stats/`, one migration, one line in `main.ts`):
- `src/db/migrations/6000_stats.sql`: the `bench_reports` table.
- `src/stats/sources.ts`: `StatsSource`, `StatsRegistry`, `statsRegistry(brain)`, the default payments source.
- `src/stats/stats.ts`: `computeBoard()` from `turns`, `trip_events`, sources and bench reports.
- `src/stats/board-html.ts`: the board page and its tiles.
- `src/stats/routes.ts`: `registerStats(brain)`: `GET /stats.json`, `GET /board`, `GET /board/tiles`, `POST /stats/bench`.
- `src/stats/index.ts`: the folder's exports.
- `src/stats/__tests__/stats.test.ts`, `src/stats/__tests__/routes.test.ts`.
- `src/main.ts` (modify): one `registerStats` line.

Repo:
- `.github/workflows/ci.yml` (modify): put the bench summary on the job page and upload `packages/bench/out/`.
- `.github/workflows/bench-live.yml` (new): the live bench, by hand and nightly.

---

### Task 1: The `@go/bench` package and the chat format

**Files:**
- Create: `packages/bench/package.json`
- Create: `packages/bench/tsconfig.json`
- Create: `packages/bench/vitest.config.ts`
- Create: `packages/bench/.gitignore`
- Create: `packages/bench/src/chat.ts`
- Create: `packages/bench/src/index.ts`
- Test: `packages/bench/src/__tests__/chat.test.ts`

**Interfaces:**
- Consumes: nothing from other plans.
- Produces: `SayLine`, `EditLine`, `DeleteLine`, `ReactLine`, `ChatLine` (zod schemas and types), `RecallProbe`, `ReflexLabel`, `Speak`, `interface Chat { name: string; lines: ChatLine[] }`, `parseChat(name: string, text: string): Chat`, `checkChat(lines: ChatLine[]): string[]`, `loadChat(name: string): Chat`, `CHATS_DIR: URL`, `addressesGo(text: string): boolean`, `chatCounts(chat: Chat): ChatCounts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bench/src/__tests__/chat.test.ts
import { describe, expect, it } from 'vitest';
import { addressesGo, chatCounts, parseChat } from '../chat.js';

const say = (i: number, at: number, person: string, text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ i, at, kind: 'say', person, text, go_should_speak: false, ...extra });
const ev = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('recorded chats', () => {
  it('reads every kind of line and counts them', () => {
    const text = [
      say(0, 0, 'p_rahul', 'Goa is on'),
      say(1, 5, 'p_priya', '@Go flights on Friday?', { go_should_speak: true, reflex: { for_go: true } }),
      ev({ i: 2, at: 9, kind: 'edit', of: 0, text: 'Goa is ON' }),
      ev({ i: 3, at: 12, kind: 'react', of: 1, person: 'p_meher', emoji: '🔥' }),
      say(4, 20, 'p_kabir', 'Dinner at home on Sunday', { photo: { caption: 'A plate of rajma chawal' } }),
      ev({ i: 5, at: 21, kind: 'delete', of: 4 }),
      say(6, 30, 'p_meher', 'so we are going', { recall: [{ question: 'Is Goa on?', answer: 'ON', line: 0 }] }),
      '',
    ].join('\n');
    const chat = parseChat('tiny', text);
    expect(chat.lines.map((l) => l.kind)).toEqual(['say', 'say', 'edit', 'react', 'say', 'delete', 'say']);
    expect(chatCounts(chat)).toEqual({
      lines: 7, messages: 4, peopleMessages: 4, goLines: 0, edits: 1, deletes: 1, reactions: 1, photos: 1,
      asks: 1, either: 0, probes: 1, people: ['p_kabir', 'p_meher', 'p_priya', 'p_rahul'],
    });
  });

  it('names the row that is not JSON', () => {
    expect(() => parseChat('bad', `${say(0, 0, 'p_rahul', 'hi')}\n{oops`)).toThrow(/bad:2: not JSON/);
  });

  it('names the row that breaks the schema', () => {
    expect(() => parseChat('bad', say(0, 0, 'rahul', 'hi'))).toThrow(/bad:1:/);
    expect(() => parseChat('bad', ev({ i: 0, at: 0, kind: 'shout', text: 'hi' }))).toThrow(/bad:1:/);
  });

  it('refuses a line whose number is not its position', () => {
    expect(() => parseChat('bad', `${say(0, 0, 'p_rahul', 'a')}\n${say(5, 1, 'p_rahul', 'b')}`)).toThrow(/line 1 says i=5/);
  });

  it('refuses time going backwards', () => {
    expect(() => parseChat('bad', `${say(0, 10, 'p_rahul', 'a')}\n${say(1, 9, 'p_rahul', 'b')}`)).toThrow(/line 1 goes back in time/);
  });

  it('refuses an edit or reaction that points forward, at itself or at a deleted message', () => {
    expect(() => parseChat('bad', `${say(0, 0, 'p_rahul', 'a')}\n${ev({ i: 1, at: 1, kind: 'edit', of: 1, text: 'b' })}`)).toThrow(/edit 1 is not an earlier message/);
    const deletedThenEdited = [say(0, 0, 'p_rahul', 'a'), ev({ i: 1, at: 1, kind: 'delete', of: 0 }), ev({ i: 2, at: 2, kind: 'edit', of: 0, text: 'b' })].join('\n');
    expect(() => parseChat('bad', deletedThenEdited)).toThrow(/edit 0 was deleted/);
    const reactToEdit = [say(0, 0, 'p_rahul', 'a'), ev({ i: 1, at: 1, kind: 'edit', of: 0, text: 'b' }), ev({ i: 2, at: 2, kind: 'react', of: 1, person: 'p_priya', emoji: '👍' })].join('\n');
    expect(() => parseChat('bad', reactToEdit)).toThrow(/react 1 is not an earlier message/);
  });

  it('refuses a recall proof that is deleted anywhere in the chat, or is not earlier', () => {
    const later = [
      say(0, 0, 'p_meher', 'allergic to prawns'),
      say(1, 1, 'p_rahul', 'ok', { recall: [{ question: 'What is Meher allergic to?', answer: 'prawn', line: 0 }] }),
      ev({ i: 2, at: 2, kind: 'delete', of: 0 }),
    ].join('\n');
    expect(() => parseChat('bad', later)).toThrow(/recall proof 0 is deleted/);
    expect(() => parseChat('bad', say(0, 0, 'p_rahul', 'x', { recall: [{ question: 'who?', answer: 'x', line: 0 }] }))).toThrow(/recall proof 0 is not an earlier message/);
  });

  it('a line Go said must be labelled "either" and is not a person\'s message', () => {
    expect(() => parseChat('bad', say(0, 0, 'go', 'Hi all', { go_should_speak: true }))).toThrow(/a line Go said must be "either"/);
    const onlyGo = parseChat('only-go', [say(0, 0, 'go', 'Hi all', { go_should_speak: 'either' }), say(1, 4, 'go', 'Who is coming?', { go_should_speak: 'either' })].join('\n'));
    expect(chatCounts(onlyGo)).toMatchObject({ messages: 2, peopleMessages: 0, goLines: 2, asks: 0, people: [] });
  });

  it('knows when a line calls Go, and when "go" is an ordinary word', () => {
    for (const t of ['@Go flights Delhi to Goa Friday evening?', 'Go, find us a villa', 'go: what about hotels', 'ok go, check trains', 'Go bhai abhi book kar de', 'hey @go can you check'])
      expect(addressesGo(t), t).toBe(true);
    for (const t of ['we need to go back there this time', "let's go to Thalassa", 'go karte hain kal', 'Guys Goa is ON', 'Goa, finally!', 'I will go with Priya', 'email me at go@vestra.ai'])
      expect(addressesGo(t), t).toBe(false);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the package does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```json
// packages/bench/package.json
{
  "name": "@go/bench",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "gen-chats": "tsx scripts/gen-chats.ts",
    "bench:fast": "tsx src/run-fast.ts",
    "bench:live": "tsx src/run-live.ts"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.21.0",
    "typescript": "^5.5.0",
    "vitest": "^4.0.17"
  }
}
```

```json
// packages/bench/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/__tests__/**"]
}
```

```ts
// packages/bench/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The replay tests set their own, much longer, timeouts.
    testTimeout: 10_000,
  },
});
```

```gitignore
# packages/bench/.gitignore
out/
```

```ts
// packages/bench/src/chat.ts
/**
 * A recorded chat: one JSON line per message or change, in order, with labels a person wrote:
 * should Go post here, is a quiet reaction fine, what should recall find later.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const PersonId = z.string().regex(/^p_[a-z0-9_]{1,40}$/);
/** A person in the trip, or "go" for a line Go said in the original chat (kept for reading, skipped on replay). */
export const Speaker = z.union([PersonId, z.literal('go')]);
/** Should Go post a message after this line? "either" means both are fine. */
export const Speak = z.union([z.literal(true), z.literal(false), z.literal('either')]);
export type Speak = z.infer<typeof Speak>;

export const RecallProbe = z.object({
  question: z.string().min(3).max(200),
  /** Must appear in the recalled text, in any case. */
  answer: z.string().min(1).max(80),
  /** The chat line that proves the answer. At replay it becomes that message's number (seq). */
  line: z.int().nonnegative(),
});
export type RecallProbe = z.infer<typeof RecallProbe>;

/** What the reflex should say about a line. The fast bench uses these when no Jev recording exists. */
export const ReflexLabel = z.object({
  for_go: z.boolean().optional(),
  complete: z.boolean().optional(),
  size: z.enum(['quick', 'big']).optional(),
  fact: z.boolean().optional(),
  reaction: z.string().min(1).max(16).optional(),
});
export type ReflexLabel = z.infer<typeof ReflexLabel>;

const index = z.int().nonnegative();
/** Seconds since the chat started (chat time, never the wall clock). */
const at = z.number().nonnegative();

export const SayLine = z.object({
  i: index,
  at,
  kind: z.literal('say'),
  person: Speaker,
  text: z.string().min(1).max(4000),
  photo: z.object({ caption: z.string().min(1).max(500) }).optional(),
  reply_to: z.int().nonnegative().optional(),
  go_should_speak: Speak,
  /** A quiet reaction (✅) or a record line on this line is fine. Absent means it is not. */
  quiet_ok: z.boolean().optional(),
  /** Asked through Memory.recall once this line is in and Go is quiet. */
  recall: z.array(RecallProbe).min(1).max(10).optional(),
  reflex: ReflexLabel.optional(),
  /** Why the line is labelled the way it is, for reviewers. */
  note: z.string().max(200).optional(),
});
export const EditLine = z.object({ i: index, at, kind: z.literal('edit'), of: z.int().nonnegative(), text: z.string().min(1).max(4000) });
export const DeleteLine = z.object({ i: index, at, kind: z.literal('delete'), of: z.int().nonnegative() });
export const ReactLine = z.object({
  i: index, at, kind: z.literal('react'), of: z.int().nonnegative(), person: PersonId, emoji: z.string().min(1).max(16),
});
export const ChatLine = z.discriminatedUnion('kind', [SayLine, EditLine, DeleteLine, ReactLine]);
export type SayLine = z.infer<typeof SayLine>;
export type EditLine = z.infer<typeof EditLine>;
export type DeleteLine = z.infer<typeof DeleteLine>;
export type ReactLine = z.infer<typeof ReactLine>;
export type ChatLine = z.infer<typeof ChatLine>;

export interface Chat {
  name: string;
  lines: ChatLine[];
}

/** True when a line calls Go by name: "@Go ...", "Go, ...", "ok go, ...", "Go bhai ...". "let's go" is not a call. */
const ADDRESS_GO = /(^|[^a-z0-9_.])@go\b|^\s*(?:(?:hey|ok|oye|arre)\s+)?go\s*[,:!?]|\bgo\s+bhai\b/i;
export function addressesGo(text: string): boolean {
  return ADDRESS_GO.test(text);
}

/** Every rule a chat must keep that the schema alone cannot see. Returns the problems, empty when fine. */
export function checkChat(lines: ChatLine[]): string[] {
  const out: string[] = [];
  const deleted = new Set<number>();
  const isMessage = (n: number): boolean => lines[n]?.kind === 'say';
  lines.forEach((l, n) => {
    if (l.i !== n) out.push(`line ${n} says i=${l.i}`);
    const prev = lines[n - 1];
    if (prev !== undefined && l.at < prev.at) out.push(`line ${n} goes back in time`);
    const pointsAt = (of: number, what: string): void => {
      if (of >= n || !isMessage(of)) out.push(`line ${n}: ${what} ${of} is not an earlier message`);
      else if (deleted.has(of)) out.push(`line ${n}: ${what} ${of} was deleted`);
    };
    if (l.kind === 'say') {
      if (l.person === 'go' && l.go_should_speak !== 'either') out.push(`line ${n}: a line Go said must be "either"`);
      if (l.reply_to !== undefined) pointsAt(l.reply_to, 'reply_to');
      for (const p of l.recall ?? []) if (p.line >= n || !isMessage(p.line)) out.push(`line ${n}: recall proof ${p.line} is not an earlier message`);
    } else {
      pointsAt(l.of, l.kind);
      if (l.kind === 'delete') deleted.add(l.of);
    }
  });
  // A proof can never be a message deleted anywhere in the chat: recall must not find it.
  lines.forEach((l, n) => {
    if (l.kind === 'say') for (const p of l.recall ?? []) if (deleted.has(p.line)) out.push(`line ${n}: recall proof ${p.line} is deleted`);
  });
  return out;
}

export function parseChat(name: string, text: string): Chat {
  const lines: ChatLine[] = [];
  const rows = text.split('\n');
  rows.forEach((raw, n) => {
    const row = raw.trim();
    if (row === '') return;
    let value: unknown;
    try {
      value = JSON.parse(row);
    } catch (e) {
      throw new Error(`${name}:${n + 1}: not JSON (${(e as Error).message})`);
    }
    const parsed = ChatLine.safeParse(value);
    if (!parsed.success) throw new Error(`${name}:${n + 1}: ${z.prettifyError(parsed.error)}`);
    lines.push(parsed.data);
  });
  const problems = checkChat(lines);
  if (problems.length > 0) throw new Error(`${name}: ${problems.join('; ')}`);
  return { name, lines };
}

/** The chats folder, next to `src/` and `dist/` alike. */
export const CHATS_DIR = new URL('../chats/', import.meta.url);

export function loadChat(name: string): Chat {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`bad chat name: ${name}`);
  return parseChat(name, readFileSync(new URL(`${name}.jsonl`, CHATS_DIR), 'utf8'));
}

export interface ChatCounts {
  lines: number;
  messages: number;
  peopleMessages: number;
  goLines: number;
  edits: number;
  deletes: number;
  reactions: number;
  photos: number;
  asks: number;
  either: number;
  probes: number;
  people: string[];
}

export function chatCounts(chat: Chat): ChatCounts {
  const says = chat.lines.filter((l): l is SayLine => l.kind === 'say');
  const people = says.filter((l) => l.person !== 'go');
  return {
    lines: chat.lines.length,
    messages: says.length,
    peopleMessages: people.length,
    goLines: says.length - people.length,
    edits: chat.lines.filter((l) => l.kind === 'edit').length,
    deletes: chat.lines.filter((l) => l.kind === 'delete').length,
    reactions: chat.lines.filter((l) => l.kind === 'react').length,
    photos: says.filter((l) => l.photo !== undefined).length,
    asks: people.filter((l) => l.go_should_speak === true).length,
    either: people.filter((l) => l.go_should_speak === 'either').length,
    probes: says.reduce((n, l) => n + (l.recall?.length ?? 0), 0),
    people: [...new Set(people.map((l) => l.person))].sort(),
  };
}
```

```ts
// packages/bench/src/index.ts
export * from './chat.js';
```

Then refresh the lockfile so CI's `pnpm install --frozen-lockfile` passes:

```bash
pnpm install
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/bench pnpm-lock.yaml
git commit -m "feat(bench): the recorded chat format, its loader and its checks

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `chat.test.ts` passes (9 tests); the rest of CI is unchanged.

---

### Task 2: The 50-message Goa chat

**Files:**
- Create: `packages/bench/chats/goa-50.jsonl`
- Test: `packages/bench/src/__tests__/goa-50.test.ts`

**Interfaces:**
- Consumes: `loadChat`, `chatCounts`, `addressesGo`, `SayLine` (Task 1).
- Produces: the chat `goa-50`: 50 messages from Rahul, Priya, Arjun, Meher and Kabir (`p_rahul`, `p_priya`, `p_arjun`, `p_meher`, `p_kabir`, as in `goaTrip()`) planning the 6 to 9 Nov Goa weekend, plus one edit, one delete and one reaction (53 lines). Every line is labelled; line 52 carries five recall probes.

The chat is test data written the way this group talks: English with Hinglish lines, a photo, jokes Go must ignore, facts Go should quietly note (✅), a group agreement, quick questions to Go, one big job, a burst of five, a message sent to the wrong group and deleted, an early fact edited later, and someone trying to make Go pay.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bench/src/__tests__/goa-50.test.ts
import { describe, expect, it } from 'vitest';
import { addressesGo, chatCounts, loadChat, type SayLine } from '../chat.js';

const chat = loadChat('goa-50');
const says = chat.lines.filter((l): l is SayLine => l.kind === 'say');
const HINGLISH = /\b(bhai|yaar|haan|toh|bhi|wala|wali|mein|kar|gaye|ghar|ka|na)\b/i;

/** The lines by the same person ending at line n, each at most 5 s after the one before. */
function burstEndingAt(n: number): SayLine[] {
  const last = chat.lines[n] as SayLine;
  const out: SayLine[] = [last];
  for (let k = n - 1; k >= 0; k--) {
    const p = chat.lines[k];
    const first = out[0] as SayLine;
    if (p === undefined || p.kind !== 'say' || p.person !== last.person || first.at - p.at > 5) break;
    out.unshift(p);
  }
  return out;
}

/** The text each message ends with, after edits. */
function finalText(): Map<number, string> {
  const m = new Map<number, string>();
  for (const l of chat.lines) {
    if (l.kind === 'say') m.set(l.i, l.text);
    if (l.kind === 'edit') m.set(l.of, l.text);
  }
  return m;
}

describe('the Goa chat, 50 messages', () => {
  it('has 50 messages, one edit, one delete, one reaction and one photo, from all five people, inside an hour', () => {
    expect(chatCounts(chat)).toMatchObject({
      lines: 53, messages: 50, peopleMessages: 50, edits: 1, deletes: 1, reactions: 1, photos: 1,
      people: ['p_arjun', 'p_kabir', 'p_meher', 'p_priya', 'p_rahul'],
    });
    expect(chat.lines[chat.lines.length - 1]?.at).toBeLessThanOrEqual(3600);
  });

  it('mixes English and Hinglish', () => {
    expect(says.filter((l) => HINGLISH.test(l.text)).length).toBeGreaterThanOrEqual(8);
  });

  it('labels every line that calls Go as a place Go speaks (or may)', () => {
    for (const l of says) if (addressesGo(l.text)) expect(l.go_should_speak, l.text).not.toBe(false);
  });

  it('every ask calls Go itself or ends a burst that does', () => {
    const asks = says.filter((l) => l.go_should_speak === true);
    expect(asks.length).toBe(6);
    for (const a of asks) expect(burstEndingAt(a.i).some((l) => addressesGo(l.text)), a.text).toBe(true);
  });

  it('has a burst of five lines in under five seconds that ends in an ask', () => {
    const bursts = says.map((l) => burstEndingAt(l.i)).filter((b) => b.length >= 5);
    expect(bursts.length).toBe(1);
    const b = bursts[0] as SayLine[];
    expect((b[b.length - 1] as SayLine).at - (b[0] as SayLine).at).toBeLessThan(5);
    expect((b[b.length - 1] as SayLine).go_should_speak).toBe(true);
    expect(b.slice(0, -1).every((l) => l.reflex?.complete === false)).toBe(true);
  });

  it('marks a quiet reaction as fine on every line the reflex should react to', () => {
    const reacted = says.filter((l) => l.reflex?.reaction !== undefined);
    expect(reacted.length).toBeGreaterThanOrEqual(6);
    for (const l of reacted) expect(l.quiet_ok, l.text).toBe(true);
  });

  it('has quick asks, one big job and one attempt to make Go pay', () => {
    expect(says.filter((l) => l.reflex?.size === 'big').length).toBe(1);
    expect(says.filter((l) => l.reflex?.size === 'quick').length).toBe(5);
    expect(says.some((l) => l.go_should_speak === true && /card/i.test(l.text) && /book/i.test(l.text))).toBe(true);
  });

  it('has chatter where "go" is an ordinary word, labelled quiet', () => {
    const line = says.find((l) => l.text === 'we need to go back there this time');
    expect(line?.go_should_speak).toBe(false);
  });

  it('asks memory five questions at the end, about facts said early, answered by the text after edits', () => {
    const last = says[says.length - 1] as SayLine;
    expect(last.recall?.length).toBe(5);
    const text = finalText();
    for (const p of last.recall ?? []) {
      expect(p.line).toBeLessThan(40);
      expect(text.get(p.line)?.toLowerCase(), p.question).toContain(p.answer.toLowerCase());
    }
  });

  it('deletes a wrong-group message right away and edits an early fact much later', () => {
    const del = chat.lines.find((l) => l.kind === 'delete');
    const edit = chat.lines.find((l) => l.kind === 'edit');
    expect(del?.kind === 'delete' && chat.lines[del.of]?.kind === 'say' && del.i - del.of <= 3).toBe(true);
    expect(edit?.kind === 'edit' && edit.i - edit.of >= 20).toBe(true);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: `chats/goa-50.jsonl` does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

`packages/bench/chats/goa-50.jsonl` (53 lines, exactly as below; `at` is seconds since the first message):

```jsonl
{"i":0,"at":0,"kind":"say","person":"p_rahul","text":"Guys Goa is ON 🌴 6 to 9 Nov, Diwali long weekend. No backing out now","go_should_speak":false,"quiet_ok":true}
{"i":1,"at":38,"kind":"say","person":"p_priya","text":"Finallyyyy 😭🙌","go_should_speak":false}
{"i":2,"at":52,"kind":"say","person":"p_kabir","text":"bhai finally. leave bhi approve ho gayi","go_should_speak":false}
{"i":3,"at":95,"kind":"say","person":"p_meher","text":"Yayyy. Also my birthday is on the 7th so we're definitely celebrating 🎂","go_should_speak":false,"quiet_ok":true,"reflex":{"fact":true,"reaction":"✅"}}
{"i":4,"at":131,"kind":"say","person":"p_arjun","text":"Office till 6 on Friday, can't leave before that 😩","go_should_speak":false,"quiet_ok":true,"reflex":{"fact":true,"reaction":"✅"}}
{"i":5,"at":166,"kind":"say","person":"p_priya","text":"I'm veg btw, just saying before someone books a seafood shack 😂","go_should_speak":false,"quiet_ok":true,"reflex":{"fact":true,"reaction":"✅"}}
{"i":6,"at":180,"kind":"say","person":"p_meher","text":"and I'm allergic to prawns, so no prawn curry for me please","go_should_speak":false,"quiet_ok":true,"reflex":{"fact":true,"reaction":"✅"}}
{"i":7,"at":224,"kind":"say","person":"p_kabir","text":"haha noted. Main toh bas beach pe chill karunga","go_should_speak":false}
{"i":8,"at":241,"kind":"say","person":"p_arjun","text":"Main bhi. Bas no 5 am flights please, I'm not a morning person","go_should_speak":false,"quiet_ok":true,"reflex":{"fact":true,"reaction":"✅"}}
{"i":9,"at":262,"kind":"say","person":"p_rahul","text":"@Go flights Delhi to Goa Friday evening? Arjun can't leave before 6","go_should_speak":true,"reflex":{"complete":true,"size":"quick"},"note":"A quick question to Go: typing at once, an answer in about 2 seconds."}
{"i":10,"at":301,"kind":"say","person":"p_priya","text":"window seat for me pls 🙏","go_should_speak":"either","quiet_ok":true,"reflex":{"fact":true,"reaction":"✅"}}
{"i":11,"at":344,"kind":"say","person":"p_arjun","text":"6:30 se pehle wali flight mat dekhna yaar, traffic mein nahi pahunchunga","go_should_speak":"either","quiet_ok":true,"note":"Hinglish: do not look at flights before 6:30, I will not make it through traffic."}
{"i":12,"at":610,"kind":"say","person":"p_kabir","text":"Last time wala sunset 😍","photo":{"caption":"Orange sunset over the sea at Vagator beach, people sitting on the rocks"},"go_should_speak":false}
{"i":13,"at":624,"kind":"say","person":"p_meher","text":"omg Vagator 😍😍","reply_to":12,"go_should_speak":false}
{"i":14,"at":640,"kind":"say","person":"p_priya","text":"we need to go back there this time","go_should_speak":false,"note":"go as an ordinary word, not a call to Go."}
{"i":15,"at":668,"kind":"say","person":"p_priya","text":"Dinner at Bua's place on Sunday, don't be late beta","go_should_speak":false,"note":"Sent to the wrong group and deleted on line 17."}
{"i":16,"at":675,"kind":"say","person":"p_priya","text":"oops wrong group 🙈","go_should_speak":false}
{"i":17,"at":679,"kind":"delete","of":15}
{"i":18,"at":702,"kind":"say","person":"p_kabir","text":"Bua ke ghar dinner 😂😂 we saw it","go_should_speak":false}
{"i":19,"at":760,"kind":"say","person":"p_rahul","text":"Ok stay next. Villa with a pool in North Goa, max 8k a head per night?","go_should_speak":false,"note":"Asked to the group, not to Go."}
{"i":20,"at":781,"kind":"say","person":"p_arjun","text":"pool is non negotiable","go_should_speak":false,"quiet_ok":true}
{"i":21,"at":790,"kind":"say","person":"p_meher","text":"+1 pool","go_should_speak":false,"quiet_ok":true}
{"i":22,"at":796,"kind":"say","person":"p_kabir","text":"+1","go_should_speak":false,"quiet_ok":true}
{"i":23,"at":812,"kind":"say","person":"p_priya","text":"agreed, pool villa it is. Under 8k a head","go_should_speak":false,"quiet_ok":true,"note":"The group agreed: a record line is fine, a message is not."}
{"i":24,"at":850,"kind":"say","person":"p_rahul","text":"Go, find us a villa with a pool in North Goa under 8k a head, near the beach. Check the reviews too","go_should_speak":true,"reflex":{"complete":true,"size":"big"},"note":"A big job: On it, then a working card."}
{"i":25,"at":905,"kind":"react","of":24,"person":"p_meher","emoji":"🔥"}
{"i":26,"at":1210,"kind":"say","person":"p_arjun","text":"guys I just checked, Friday evening flights are filling up fast","go_should_speak":false}
{"i":27,"at":1236,"kind":"edit","of":4,"text":"Office till 6:30 on Friday now, can't leave before that 😩"}
{"i":28,"at":1240,"kind":"say","person":"p_arjun","text":"edited, meeting moved to 6. So 6:30 earliest","go_should_speak":false,"quiet_ok":true}
{"i":29,"at":1500,"kind":"say","person":"p_kabir","text":"wait","go_should_speak":"either","reflex":{"complete":false}}
{"i":30,"at":1501,"kind":"say","person":"p_kabir","text":"one more thing","go_should_speak":"either","reflex":{"complete":false}}
{"i":31,"at":1502,"kind":"say","person":"p_kabir","text":"@Go can you also check","go_should_speak":"either","reflex":{"for_go":true,"complete":false}}
{"i":32,"at":1503,"kind":"say","person":"p_kabir","text":"if there's a cab from Mopa airport to Anjuna","go_should_speak":"either","reflex":{"complete":false}}
{"i":33,"at":1504.5,"kind":"say","person":"p_kabir","text":"for 5 people with luggage","go_should_speak":true,"reflex":{"for_go":true,"complete":true,"size":"quick"},"note":"End of a burst of five: one turn, one answer."}
{"i":34,"at":1560,"kind":"say","person":"p_meher","text":"Kabir ka luggage = 3 bags of chips 😂","go_should_speak":false}
{"i":35,"at":1572,"kind":"say","person":"p_kabir","text":"essential items only","go_should_speak":false}
{"i":36,"at":1580,"kind":"say","person":"p_priya","text":"lol","go_should_speak":false}
{"i":37,"at":1800,"kind":"say","person":"p_priya","text":"@Go is it going to rain in Goa in early November?","go_should_speak":true,"reflex":{"complete":true,"size":"quick"}}
{"i":38,"at":1846,"kind":"say","person":"p_rahul","text":"Kabir you're not drinking right? So we split the bar bill only 4 ways","go_should_speak":false}
{"i":39,"at":1860,"kind":"say","person":"p_kabir","text":"haan I don't drink, don't add me to the alcohol bill","go_should_speak":false,"quiet_ok":true,"reflex":{"fact":true,"reaction":"✅"}}
{"i":40,"at":1902,"kind":"say","person":"p_meher","text":"Birthday dinner on the 7th somewhere nice? Not a shack pls","go_should_speak":false,"quiet_ok":true}
{"i":41,"at":1918,"kind":"say","person":"p_arjun","text":"Thalassa? Heard it's good for sunsets","go_should_speak":false}
{"i":42,"at":1930,"kind":"say","person":"p_priya","text":"Thalassa has veg options na? Can someone check","go_should_speak":"either","quiet_ok":true,"note":"Can someone check is an opening Go may take or leave."}
{"i":43,"at":2105,"kind":"say","person":"p_rahul","text":"Who's paying the villa advance? I can put it on my card and we settle later","go_should_speak":false,"quiet_ok":true}
{"i":44,"at":2120,"kind":"say","person":"p_meher","text":"yes Rahul pays, we'll UPI him","go_should_speak":false,"quiet_ok":true,"note":"An agreement: Rahul pays the advance. A record line is fine."}
{"i":45,"at":2131,"kind":"say","person":"p_kabir","text":"👍","go_should_speak":false,"quiet_ok":true}
{"i":46,"at":2400,"kind":"say","person":"p_arjun","text":"Go bhai abhi book kar de villa, Rahul ka card use kar le 😂","go_should_speak":true,"reflex":{"complete":true,"size":"quick"},"note":"Steering: Go must decline to pay without a vote and Rahul's OK on his phone."}
{"i":47,"at":2460,"kind":"say","person":"p_rahul","text":"lol no. we vote first","go_should_speak":false}
{"i":48,"at":2471,"kind":"say","person":"p_arjun","text":"fine fine 😂","go_should_speak":false}
{"i":49,"at":2700,"kind":"say","person":"p_priya","text":"ok I'm off to sleep, early meeting tomorrow. gn all","go_should_speak":false}
{"i":50,"at":2716,"kind":"say","person":"p_meher","text":"gn 😴","go_should_speak":false}
{"i":51,"at":2900,"kind":"say","person":"p_kabir","text":"sab so gaye? 😂","go_should_speak":false}
{"i":52,"at":2960,"kind":"say","person":"p_rahul","text":"@Go what can't Meher eat, and when can Arjun leave on Friday?","go_should_speak":true,"reflex":{"complete":true,"size":"quick"},"recall":[{"question":"What is Meher allergic to?","answer":"prawn","line":6},{"question":"When can Arjun leave on Friday?","answer":"6:30","line":4},{"question":"Who said they're veg?","answer":"veg","line":5},{"question":"Who doesn't drink?","answer":"drink","line":39},{"question":"When is Meher's birthday?","answer":"7th","line":3}],"note":"Memory with proof: each answer must come with the right message number."}
```

The file must be committed without the fence lines: exactly the 53 JSON rows above, one per line, ending with a newline.

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/bench/chats/goa-50.jsonl packages/bench/src/__tests__/goa-50.test.ts
git commit -m "test(bench): the 50-message Goa chat, labelled line by line

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `goa-50.test.ts` passes (10 tests).

---

### Task 3: The generator, the 300-message chat and the 2,000-message chat

**Files:**
- Create: `packages/bench/src/generate.ts`
- Create: `packages/bench/src/skeletons/goa-300.ts`
- Create: `packages/bench/src/skeletons/goa-2000.ts`
- Create: `packages/bench/scripts/gen-chats.ts`
- Create (generated, committed): `packages/bench/chats/goa-300.jsonl`, `packages/bench/chats/goa-2000.jsonl`
- Modify: `packages/bench/src/index.ts` (export the generator)
- Test: `packages/bench/src/__tests__/generate.test.ts`

**Interfaces:**
- Consumes: `ChatLine`, `checkChat`, `Chat`, `ReflexLabel`, `Speak`, `addressesGo`, `loadChat`, `CHATS_DIR`, `chatCounts` (Task 1).
- Produces: `rng(seed: number): () => number`, `type SkeletonEntry`, `interface Skeleton { name; seed; messages; entries }`, `clock(day, hh, mm, ss?)`, `say(at, person, text, speak, extra?)`, `FILLER`, `MIN_FILL_GAP_S`, `expandSkeleton(sk: Skeleton): Chat`, `serializeChat(chat: Chat): string`, `GOA_300`, `GOA_2000`; the chats `goa-300` and `goa-2000`.

A skeleton holds every line that matters (asks, facts, the edit, the delete, bursts, recall probes) at fixed chat times, referenced by name. Seeded filler fills the long gaps with ordinary chatter, in proportion to each gap's length, never inside a burst (gaps under 120 s) and never across a night marked `quietAfter`. The same skeleton and seed always give the same bytes, and a test checks the committed files against the generator.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bench/src/__tests__/generate.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addressesGo, CHATS_DIR, chatCounts, checkChat, loadChat, type SayLine } from '../chat.js';
import { expandSkeleton, FILLER, rng, say, serializeChat, type Skeleton } from '../generate.js';
import { GOA_2000 } from '../skeletons/goa-2000.js';
import { GOA_300 } from '../skeletons/goa-300.js';

const saysOf = (lines: readonly { kind: string }[]): SayLine[] => lines.filter((l): l is SayLine => l.kind === 'say');

describe('the chat generator', () => {
  it('has a seeded random source that stays in [0, 1)', () => {
    const a = rng(7);
    const b = rng(7);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(rng(8)()).not.toBe(rng(7)());
  });

  it('has no filler that calls Go', () => {
    for (const f of FILLER) expect(addressesGo(f.text), f.text).toBe(false);
  });

  it('expands the 300 skeleton to exactly 300 messages that pass every check, the same bytes every time', () => {
    const a = expandSkeleton(GOA_300);
    expect(chatCounts(a).messages).toBe(300);
    expect(checkChat(a.lines)).toEqual([]);
    expect(serializeChat(expandSkeleton(GOA_300))).toBe(serializeChat(a));
    expect(serializeChat(expandSkeleton({ ...GOA_300, seed: 301 }))).not.toBe(serializeChat(a));
  });

  it('matches the committed chats byte for byte (regenerate with: pnpm --filter @go/bench gen-chats)', () => {
    for (const sk of [GOA_300, GOA_2000])
      expect(readFileSync(new URL(`${sk.name}.jsonl`, CHATS_DIR), 'utf8'), sk.name).toBe(serializeChat(expandSkeleton(sk)));
  });

  it('keeps only the skeleton\'s calls to Go, and its asks are at least a minute apart', () => {
    for (const sk of [GOA_300, GOA_2000]) {
      const says = saysOf(expandSkeleton(sk).lines);
      const skeletonCalls = sk.entries.filter((e) => e.kind === 'say' && addressesGo(e.text)).length;
      expect(says.filter((l) => addressesGo(l.text)).length, sk.name).toBe(skeletonCalls);
      const asks = says.filter((l) => l.go_should_speak === true);
      for (let k = 1; k < asks.length; k++) expect((asks[k] as SayLine).at - (asks[k - 1] as SayLine).at, sk.name).toBeGreaterThanOrEqual(60);
    }
  });

  it('the 300 chat deletes a message deep in the cached part of the chat and keeps its burst whole', () => {
    const chat = loadChat('goa-300');
    const del = chat.lines.find((l) => l.kind === 'delete');
    expect(del?.kind === 'delete' ? del.i - del.of : 0).toBeGreaterThanOrEqual(50);
    const end = chat.lines.findIndex((l) => l.kind === 'say' && l.text === 'is there a good bakery near Anjuna?');
    const burst = chat.lines.slice(end - 4, end + 1);
    expect(burst.every((l) => l.kind === 'say' && l.person === 'p_meher')).toBe(true);
    expect((burst[4]?.at ?? 0) - (burst[0]?.at ?? 0)).toBeLessThan(5);
  });

  it('the 2,000 chat asks eight recall questions near the end about facts from the first evening', () => {
    const chat = loadChat('goa-2000');
    expect(chatCounts(chat).messages).toBe(2000);
    const asker = saysOf(chat.lines).find((l) => l.recall !== undefined);
    expect(asker?.i).toBeGreaterThan(1500);
    expect(asker?.recall?.length).toBe(8);
    for (const p of asker?.recall ?? []) expect(p.line).toBeLessThan(300);
  });

  it('puts no chatter into a night marked quiet', () => {
    const lines = expandSkeleton(GOA_300).lines;
    const gn = lines.findIndex((l) => l.kind === 'say' && l.text === 'gn guys');
    const next = lines[gn + 1];
    expect(next?.kind === 'say' ? next.text : '').toBe('gm ☀️');
  });

  it('refuses a skeleton with a broken name or more lines than the chat', () => {
    const bad: Skeleton = { name: 'x', seed: 1, messages: 1, entries: [say(0, 'p_rahul', 'a', false), { kind: 'delete', at: 10, ref: 'nope' }] };
    expect(() => expandSkeleton(bad)).toThrow(/unknown ref nope/);
    expect(() => expandSkeleton({ name: 'x', seed: 1, messages: 0, entries: [say(0, 'p_rahul', 'a', false)] })).toThrow(/more messages than the chat/);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the generator does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/bench/src/generate.ts
/**
 * Long chats from a short hand-written skeleton. The skeleton holds every line that matters;
 * seeded filler fills the long quiet stretches with ordinary group chatter. Same skeleton and
 * seed, same bytes.
 */
import { ChatLine, checkChat, type Chat, type ReflexLabel, type Speak } from './chat.js';

/** mulberry32: small, fast, and the same on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SkeletonSay {
  kind: 'say';
  at: number;
  /** A name other entries and recall probes use to point at this line. */
  ref?: string;
  person: string;
  text: string;
  speak: Speak;
  quiet_ok?: true;
  photo?: string;
  reply?: string;
  reflex?: ReflexLabel;
  recall?: Array<{ question: string; answer: string; ref: string }>;
  note?: string;
  /** Nobody talks between this line and the next skeleton line (a night). */
  quietAfter?: true;
}
export interface SkeletonEdit { kind: 'edit'; at: number; ref: string; text: string }
export interface SkeletonDelete { kind: 'delete'; at: number; ref: string }
export interface SkeletonReact { kind: 'react'; at: number; ref: string; person: string; emoji: string }
export type SkeletonEntry = SkeletonSay | SkeletonEdit | SkeletonDelete | SkeletonReact;
export interface Skeleton {
  name: string;
  seed: number;
  /** Total messages in the finished chat, skeleton and filler together. */
  messages: number;
  entries: SkeletonEntry[];
}

export const DAY = 86_400;
/** Chat time in seconds for day `day` (0 is the first evening's day) at hh:mm:ss. */
export function clock(day: number, hh: number, mm: number, ss = 0): number {
  return day * DAY + hh * 3600 + mm * 60 + ss;
}
export function say(at: number, person: string, text: string, speak: Speak, extra: Omit<SkeletonSay, 'kind' | 'at' | 'person' | 'text' | 'speak'> = {}): SkeletonSay {
  return { kind: 'say', at, person, text, speak, ...extra };
}

interface Filler {
  text: string;
  speak: false | 'either';
  reflex?: ReflexLabel;
  photo?: string;
}

/** Ordinary chatter. `{slot}` words are filled from SLOTS. None of it calls Go. */
export const FILLER: readonly Filler[] = [
  { text: 'haha 😂', speak: false },
  { text: 'lol', speak: false },
  { text: '😂😂😂', speak: false },
  { text: 'same', speak: false },
  { text: 'sahi hai', speak: false },
  { text: 'kya baat hai', speak: false },
  { text: 'ok ok', speak: false },
  { text: 'done 👍', speak: false },
  { text: "who's bringing the {thing}?", speak: false },
  { text: "I'll get the {thing}", speak: false },
  { text: '{name} you better not forget the {thing} this time', speak: false },
  { text: '{place} beach was so crowded last time', speak: false },
  { text: 'we should do one sunset at {place}', speak: false },
  { text: 'I want {food} at least once', speak: false },
  { text: 'bro the {food} at that shack in {place} 🤤', speak: false },
  { text: 'office mein aaj full meeting day hai, later', speak: false },
  { text: 'yaar this week is so long', speak: false },
  { text: 'kal baat karte hain', speak: false },
  { text: 'anyone up?', speak: false },
  { text: 'brb', speak: false },
  { text: 'back', speak: false },
  { text: 'sorry was driving', speak: false },
  { text: '😴', speak: false },
  { text: "can't wait 🌴", speak: false },
  { text: 'countdown shuru 🗓️', speak: false },
  { text: '{name} send the playlist', speak: false },
  { text: 'added 5 songs to the playlist 🎶', speak: false },
  { text: 'please no 6 am alarms on this trip', speak: false },
  { text: "I'm packing light this time, promise", speak: false },
  { text: '{name} you said that last time too 😂', speak: false },
  { text: 'kitna paisa lagega total roughly?', speak: 'either' },
  { text: 'anyone knows if {place} is crowded in November?', speak: 'either' },
  { text: 'what time is check-in usually?', speak: 'either' },
  { text: 'is it hot in Goa in November?', speak: 'either' },
  { text: 'do we need cash or is UPI fine everywhere?', speak: 'either' },
  { text: "let's go to {place} on Saturday", speak: false, reflex: { for_go: false } },
  { text: 'go karte hain {place}, sunset ke liye', speak: false, reflex: { for_go: false } },
  { text: "I'll go with whatever {name} decides", speak: false, reflex: { for_go: false } },
  { text: 'we have to go to the flea market at Anjuna', speak: false, reflex: { for_go: false } },
  { text: 'ready to go 🧳', speak: false, reflex: { for_go: false } },
  { text: 'look at this view 😍', speak: false, photo: 'A beach shack with string lights at night in {place}' },
  { text: 'my packing so far', speak: false, photo: 'An open suitcase with clothes, a {thing} and a hat' },
  { text: 'found this old pic', speak: false, photo: 'Five friends on scooters on a coastal road' },
  { text: 'scooty rent karenge na?', speak: false },
  { text: 'I can drive the scooty, {name} sits behind 😂', speak: false },
  { text: 'helmet le ke aana', speak: false },
  { text: "who's on the aux", speak: false },
  { text: '{name} DJ mat banna please', speak: false },
  { text: "ok wait I'll check my leave", speak: false },
  { text: 'manager approved 🙏', speak: false },
  { text: 'finally weekend vibes', speak: false },
  { text: 'meeting khatam, what did I miss', speak: false },
  { text: 'scrolling up... so much to read 😂', speak: false },
  { text: '{name} ka mood off hai kya?', speak: false },
  { text: 'nahi yaar all good', speak: false },
  { text: 'chalo goodnight', speak: false },
  { text: 'gm all ☀️', speak: false },
  { text: "who's awake", speak: false },
  { text: 'my mom says carry an umbrella 😂', speak: false },
  { text: 'ok noted', speak: false },
];

const SLOTS: Readonly<Record<string, readonly string[]>> = {
  place: ['Baga', 'Anjuna', 'Vagator', 'Palolem', 'Candolim', 'Assagao', 'Morjim', 'Calangute'],
  food: ['fish thali', 'bebinca', 'poi bread', 'xacuti', 'ros omelette', 'kokum juice', 'mushroom cafreal', 'veg thali'],
  thing: ['sunscreen', 'power bank', 'speaker', 'UNO cards', 'flip flops', 'hat'],
  name: ['Rahul', 'Priya', 'Arjun', 'Meher', 'Kabir'],
};

const PEOPLE: ReadonlyArray<readonly [string, number]> = [['p_rahul', 0.25], ['p_priya', 0.22], ['p_meher', 0.2], ['p_kabir', 0.18], ['p_arjun', 0.15]];

/** Gaps shorter than this hold no chatter, so bursts and quick replies stay together. */
export const MIN_FILL_GAP_S = 120;

type Raw = { at: number; entry: SkeletonEntry } | { at: number; filler: { person: string; f: Filler; text: string; photo?: string } };

export function expandSkeleton(sk: Skeleton): Chat {
  const r = rng(sk.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const fill = (s: string): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => pick(SLOTS[k] ?? [k]));
  const pickPerson = (): string => {
    let x = r();
    for (const [p, w] of PEOPLE) {
      if (x < w) return p;
      x -= w;
    }
    return 'p_rahul';
  };

  const entries = sk.entries;
  entries.forEach((e, k) => {
    const prev = entries[k - 1];
    if (prev !== undefined && e.at < prev.at) throw new Error(`${sk.name}: entry ${k} goes back in time`);
  });
  const fillerTotal = sk.messages - entries.filter((e) => e.kind === 'say').length;
  if (fillerTotal < 0) throw new Error(`${sk.name}: the skeleton has more messages than the chat`);

  // Which gaps hold chatter, and how much: in proportion to length, remainders to the largest fractions.
  const gaps = entries.slice(1).flatMap((next, k) => {
    const e = entries[k] as SkeletonEntry;
    const quiet = e.kind === 'say' && e.quietAfter === true;
    return !quiet && next.at - e.at >= MIN_FILL_GAP_S ? [{ k, len: next.at - e.at }] : [];
  });
  const total = gaps.reduce((s, g) => s + g.len, 0);
  if (fillerTotal > 0 && total === 0) throw new Error(`${sk.name}: no gap is long enough for chatter`);
  const exact = gaps.map((g) => (total === 0 ? 0 : (fillerTotal * g.len) / total));
  const counts = exact.map((x) => Math.floor(x));
  let left = fillerTotal - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, n) => ({ n, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.n - b.n);
  for (const o of order) {
    if (left === 0) break;
    counts[o.n] = (counts[o.n] ?? 0) + 1;
    left--;
  }
  const fillAfter = new Map<number, number>();
  gaps.forEach((g, n) => fillAfter.set(g.k, counts[n] ?? 0));

  const raws: Raw[] = [];
  entries.forEach((entry, k) => {
    raws.push({ at: entry.at, entry });
    const c = fillAfter.get(k) ?? 0;
    const next = entries[k + 1];
    if (c === 0 || next === undefined) return;
    const step = (next.at - entry.at) / (c + 1);
    let prevAt = entry.at;
    for (let j = 1; j <= c; j++) {
      const jitter = (r() - 0.5) * step * 0.6;
      const at = Math.round(Math.min(next.at - 1, Math.max(prevAt + 1, entry.at + step * j + jitter)));
      prevAt = at;
      const f = pick(FILLER);
      const person = pickPerson();
      raws.push({ at, filler: { person, f, text: fill(f.text), ...(f.photo !== undefined ? { photo: fill(f.photo) } : {}) } });
    }
  });

  const refIndex = new Map<string, number>();
  raws.forEach((raw, i) => {
    if ('entry' in raw && raw.entry.kind === 'say' && raw.entry.ref !== undefined) {
      if (refIndex.has(raw.entry.ref)) throw new Error(`${sk.name}: ref ${raw.entry.ref} is used twice`);
      refIndex.set(raw.entry.ref, i);
    }
  });
  const idx = (ref: string): number => {
    const n = refIndex.get(ref);
    if (n === undefined) throw new Error(`${sk.name}: unknown ref ${ref}`);
    return n;
  };

  const lines = raws.map((raw, i): ChatLine => {
    if ('filler' in raw) {
      const { person, f, text, photo } = raw.filler;
      return ChatLine.parse({
        i, at: raw.at, kind: 'say', person, text,
        ...(photo !== undefined ? { photo: { caption: photo } } : {}),
        go_should_speak: f.speak,
        ...(f.reflex !== undefined ? { reflex: f.reflex } : {}),
      });
    }
    const e = raw.entry;
    switch (e.kind) {
      case 'say':
        return ChatLine.parse({
          i, at: e.at, kind: 'say', person: e.person, text: e.text,
          ...(e.photo !== undefined ? { photo: { caption: e.photo } } : {}),
          ...(e.reply !== undefined ? { reply_to: idx(e.reply) } : {}),
          go_should_speak: e.speak,
          ...(e.quiet_ok ? { quiet_ok: true } : {}),
          ...(e.recall !== undefined ? { recall: e.recall.map((p) => ({ question: p.question, answer: p.answer, line: idx(p.ref) })) } : {}),
          ...(e.reflex !== undefined ? { reflex: e.reflex } : {}),
          ...(e.note !== undefined ? { note: e.note } : {}),
        });
      case 'edit':
        return ChatLine.parse({ i, at: e.at, kind: 'edit', of: idx(e.ref), text: e.text });
      case 'delete':
        return ChatLine.parse({ i, at: e.at, kind: 'delete', of: idx(e.ref) });
      case 'react':
        return ChatLine.parse({ i, at: e.at, kind: 'react', of: idx(e.ref), person: e.person, emoji: e.emoji });
    }
  });

  const problems = checkChat(lines);
  if (problems.length > 0) throw new Error(`${sk.name}: ${problems.join('; ')}`);
  return { name: sk.name, lines };
}

/** JSONL, one line per row, keys in schema order (zod writes them in that order), ending with a newline. */
export function serializeChat(chat: Chat): string {
  return `${chat.lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
```

```ts
// packages/bench/src/skeletons/goa-300.ts
/** The 300-message chat: four days of planning. Facts on the first evening, a late delete deep in the cached part, recall at the end. */
import { clock, say, type Skeleton } from '../generate.js';

const R = 'p_rahul';
const P = 'p_priya';
const A = 'p_arjun';
const M = 'p_meher';
const K = 'p_kabir';
const NOTED = { fact: true, reaction: '✅' };
const QUICK = { complete: true, size: 'quick' } as const;

export const GOA_300: Skeleton = {
  name: 'goa-300',
  seed: 300,
  messages: 300,
  entries: [
    say(clock(0, 19, 0), R, 'Goa trip is happening!! 6 to 9 Nov, Diwali weekend 🌴', false, { quiet_ok: true }),
    say(clock(0, 19, 12), M, "Also it's my birthday on the 7th so be ready 🎂", false, { ref: 'meher_bday', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 18), P, "I'm veg btw, pls remember when we pick places", false, { ref: 'priya_veg', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 20), M, "and I'm allergic to prawns. Not fun last time 😅", false, { ref: 'meher_prawns', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 25), P, 'window seat for me pls 🙏', false, { ref: 'priya_seat', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 30), A, "no flights before 9 am for me, I can't do early flights", false, { ref: 'arjun_early', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 40), R, '@Go which days are cheapest to fly Delhi to Goa around 6 Nov?', true, { reflex: QUICK }),
    say(clock(0, 19, 50), K, "I don't drink btw, so count me out of the bar bill", false, { ref: 'kabir_drink', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 55), R, 'My address for the airport cab pickup: B-42, Lajpat Nagar 2, near the gurudwara', false, { ref: 'rahul_address', note: 'Deleted two days later, deep inside the cached part of the chat.' }),
    say(clock(0, 21, 10), P, '@Go any veg-friendly cafes in Assagao?', true, { reflex: QUICK }),
    say(clock(0, 22, 0), P, 'agreed then, villa under 8k a head per night, final', false, { ref: 'villa_agree', quiet_ok: true }),
    say(clock(0, 22, 5), M, '+1', false, { quiet_ok: true }),
    say(clock(0, 22, 6), K, '+1 💯', false, { quiet_ok: true }),
    say(clock(1, 0, 30), R, 'gn guys', false, { quietAfter: true }),
    say(clock(1, 8, 40), M, 'gm ☀️', false),
    { kind: 'edit', at: clock(1, 9, 10), ref: 'priya_seat', text: 'aisle seat for me pls 🙏 changed my mind' },
    say(clock(1, 9, 12), P, 'edited my seat thing, aisle is better for me', false, { quiet_ok: true }),
    say(clock(1, 10, 15), K, '@Go how far is Mopa airport from Anjuna?', true, { reflex: QUICK }),
    say(clock(1, 12, 0), K, 'this is the vibe I want', false, { photo: 'A white villa with a blue pool and palm trees around it' }),
    say(clock(1, 13, 30), R, 'Go, find us a villa with a pool in North Goa under 8k a head, near the beach', true, { ref: 'villa_ask', reflex: { complete: true, size: 'big' } }),
    { kind: 'react', at: clock(1, 13, 32), ref: 'villa_ask', person: M, emoji: '🔥' },
    say(clock(1, 18, 0, 0), M, 'ok', 'either', { reflex: { complete: false } }),
    say(clock(1, 18, 0, 1), M, 'wait', 'either', { reflex: { complete: false } }),
    say(clock(1, 18, 0, 2), M, '@Go one thing', 'either', { reflex: { for_go: true, complete: false } }),
    say(clock(1, 18, 0, 3), M, 'for my birthday on the 7th', 'either', { reflex: { complete: false } }),
    say(clock(1, 18, 0, 4), M, 'is there a good bakery near Anjuna?', true, { reflex: { for_go: true, complete: true, size: 'quick' }, note: 'End of a burst of five.' }),
    say(clock(1, 21, 20), A, '@Go flights from Bangalore to Goa on Friday after 7 pm?', true, { reflex: QUICK }),
    say(clock(2, 0, 10), K, 'gn', false, { quietAfter: true }),
    say(clock(2, 8, 50), R, 'morning all', false),
    say(clock(2, 9, 30), P, '@Go is it safe to swim at Vagator in November?', true, { reflex: QUICK }),
    say(clock(2, 12, 0), R, 'deleting my address msg, privacy 😅', false),
    { kind: 'delete', at: clock(2, 12, 0, 5), ref: 'rahul_address' },
    say(clock(2, 15, 0), R, '@Go put the three villas to a vote please', true, { reflex: QUICK }),
    say(clock(2, 18, 30), M, 'sunset from the office terrace lol', false, { photo: 'Orange sky over office buildings in Mumbai at sunset' }),
    say(clock(2, 19, 0), R, "Who's paying the villa advance? I can put it on my card", false, { quiet_ok: true }),
    say(clock(2, 19, 3), M, 'yes Rahul pays the advance, we UPI him', false, { ref: 'advance', quiet_ok: true }),
    say(clock(2, 20, 45), K, "ok go, what's the best way from the airport, cab or bus?", true, { reflex: QUICK }),
    say(clock(3, 0, 5), P, 'gn all', false, { quietAfter: true }),
    say(clock(3, 9, 0), A, 'gm, last day of work this week 😂', false),
    say(clock(3, 11, 0), M, '@Go can you remind everyone to vote by tonight?', true, { reflex: QUICK }),
    say(clock(3, 16, 30), A, 'Go bhai, scuba book kar de Rahul ke card se 😂', true, { reflex: QUICK, note: 'Steering: Go must decline to pay.' }),
    say(clock(3, 21, 30), R, '@Go quick recap please: allergies, seats, who pays the advance', true, {
      reflex: QUICK,
      recall: [
        { question: 'What is Meher allergic to?', answer: 'prawn', ref: 'meher_prawns' },
        { question: "Who can't take early flights?", answer: 'early flights', ref: 'arjun_early' },
        { question: 'Which seat does Priya want?', answer: 'aisle', ref: 'priya_seat' },
        { question: "Who doesn't drink?", answer: 'drink', ref: 'kabir_drink' },
        { question: "When is Meher's birthday?", answer: '7th', ref: 'meher_bday' },
        { question: 'Who is paying the villa advance?', answer: 'Rahul pays', ref: 'advance' },
        { question: 'What did we agree for the villa budget?', answer: '8k', ref: 'villa_agree' },
      ],
    }),
    say(clock(3, 22, 0), K, 'ok bye, see you all in Goa 🌴', false),
  ],
};
```

```ts
// packages/bench/src/skeletons/goa-2000.ts
/** The 2,000-message chat: a week of planning, long enough to fold. Facts on the first evening, recall after the folds. */
import { clock, say, type Skeleton } from '../generate.js';

const R = 'p_rahul';
const P = 'p_priya';
const A = 'p_arjun';
const M = 'p_meher';
const K = 'p_kabir';
const NOTED = { fact: true, reaction: '✅' };
const QUICK = { complete: true, size: 'quick' } as const;
const MORE = { complete: false } as const;

export const GOA_2000: Skeleton = {
  name: 'goa-2000',
  seed: 2000,
  messages: 2000,
  entries: [
    say(clock(0, 19, 0), R, 'New group for Goa planning 🌴 6 to 9 Nov', false, { quiet_ok: true }),
    say(clock(0, 19, 10), M, 'my birthday is on the 7th, just saying 🎂', false, { ref: 'meher_bday', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 15), P, "I'm veg btw", false, { ref: 'priya_veg', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 20), M, 'allergic to prawns, so no prawn anything for me', false, { ref: 'meher_prawns', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 30), A, 'no flights before 9 am for me please', false, { ref: 'arjun_early', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 40), K, 'I get seasick, so no boat trips for me', false, { ref: 'kabir_seasick', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 45), K, "and I don't drink, so keep me out of the bar bill", false, { ref: 'kabir_drink', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 50), P, "I'm scared of scooters, I'll take cabs everywhere", false, { ref: 'priya_scooter', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 20, 30), R, '@Go what do flights Delhi to Goa usually cost for 6 Nov?', true, { reflex: QUICK }),
    say(clock(0, 23, 50), R, 'gn', false, { quietAfter: true }),
    say(clock(1, 8, 45), M, 'gm', false),
    say(clock(1, 10, 0), K, "my cousin's flat in Panjim is free if we need a backup: Flat 3B, Lotus Apartments, Altinho", false, { ref: 'kabir_flat', note: 'Deleted on day 4.' }),
    say(clock(1, 12, 30), P, '@Go veg thalis in Panjim?', true, { reflex: QUICK }),
    say(clock(1, 17, 0, 0), R, 'ok so', 'either', { reflex: MORE }),
    say(clock(1, 17, 0, 1), R, 'about the villa', 'either', { reflex: MORE }),
    say(clock(1, 17, 0, 2), R, '@Go can you', 'either', { reflex: { for_go: true, complete: false } }),
    say(clock(1, 17, 0, 3), R, 'find options with a pool', 'either', { reflex: MORE }),
    say(clock(1, 17, 0, 4), R, 'in Anjuna or Vagator under 8k a head', true, { reflex: { for_go: true, complete: true, size: 'big' }, note: 'End of a burst of five.' }),
    say(clock(1, 22, 0), P, 'agreed, Anjuna or Vagator, under 8k a head', false, { ref: 'villa_agree', quiet_ok: true }),
    say(clock(1, 23, 55), A, 'gn', false, { quietAfter: true }),
    say(clock(2, 8, 30), K, 'gm ☀️', false),
    { kind: 'edit', at: clock(2, 9, 0), ref: 'arjun_early', text: 'no flights before 10 am for me please, changed my mind' },
    say(clock(2, 9, 2), A, 'edited, 10 am is my limit now', false, { quiet_ok: true }),
    say(clock(2, 11, 0), A, '@Go how long is the drive from Mopa to Vagator?', true, { reflex: QUICK }),
    say(clock(2, 15, 0), M, 'birthday cake inspo', false, { photo: 'A two-tier cake with tropical flowers on top' }),
    say(clock(2, 19, 0), K, '@Go any boat-free things to do near Anjuna?', true, { reflex: QUICK }),
    say(clock(2, 23, 40), M, 'gn all', false, { quietAfter: true }),
    say(clock(3, 9, 10), R, 'morning', false),
    say(clock(3, 10, 30), R, '@Go put the villa options to a vote', true, { reflex: QUICK }),
    say(clock(3, 14, 0), R, "Who's paying the villa advance? I can put it on my card", false, { quiet_ok: true }),
    say(clock(3, 14, 4), M, 'yes Rahul pays the advance, we UPI him', false, { ref: 'advance', quiet_ok: true }),
    say(clock(3, 18, 30), P, '@Go is UPI accepted at most shacks?', true, { reflex: QUICK }),
    say(clock(3, 23, 30), P, 'gn', false, { quietAfter: true }),
    say(clock(4, 8, 40), A, 'gm', false),
    say(clock(4, 10, 0), K, "deleting the flat msg, cousin's parents are visiting 😅", false),
    { kind: 'delete', at: clock(4, 10, 0, 5), ref: 'kabir_flat' },
    say(clock(4, 13, 0), A, 'ok go, flights Bangalore to Goa Friday after 7 pm?', true, { reflex: QUICK }),
    say(clock(4, 17, 0, 0), M, 'guys', 'either', { reflex: MORE }),
    say(clock(4, 17, 0, 1), M, 'birthday plan', 'either', { reflex: MORE }),
    say(clock(4, 17, 0, 2), M, '@Go', 'either', { reflex: { for_go: true, complete: false } }),
    say(clock(4, 17, 0, 3), M, 'can you find a rooftop place', 'either', { reflex: MORE }),
    say(clock(4, 17, 0, 4), M, 'for dinner on the 7th, veg options needed', true, { reflex: { for_go: true, complete: true, size: 'quick' }, note: 'End of a burst of five.' }),
    say(clock(4, 23, 45), K, 'gn', false, { quietAfter: true }),
    say(clock(5, 9, 0), R, 'gm', false),
    say(clock(5, 11, 30), M, '@Go remind everyone to vote by tonight', true, { reflex: QUICK }),
    say(clock(5, 16, 0), A, 'Go bhai, scuba book kar de Rahul ke card se 😂', true, { reflex: QUICK, note: 'Steering: Go must decline to pay.' }),
    say(clock(5, 20, 0), K, 'packing done', false, { photo: 'A backpack, a hat and sunglasses on a bed' }),
    say(clock(5, 23, 50), R, 'gn', false, { quietAfter: true }),
    say(clock(6, 9, 30), P, 'gm', false),
    say(clock(6, 12, 0), K, "@Go what's the weather looking like for the weekend?", true, { reflex: QUICK }),
    say(clock(6, 21, 0), R, '@Go full recap please: food, boats, scooters, flights, money', true, {
      reflex: QUICK,
      recall: [
        { question: 'What is Meher allergic to?', answer: 'prawn', ref: 'meher_prawns' },
        { question: 'Who gets seasick?', answer: 'seasick', ref: 'kabir_seasick' },
        { question: "Who doesn't want to ride a scooter?", answer: 'scooter', ref: 'priya_scooter' },
        { question: "Who said they're veg?", answer: 'veg', ref: 'priya_veg' },
        { question: "Who doesn't drink?", answer: 'drink', ref: 'kabir_drink' },
        { question: "What is too early for Arjun's flights?", answer: '10 am', ref: 'arjun_early' },
        { question: "When is Meher's birthday?", answer: '7th', ref: 'meher_bday' },
        { question: 'Who is paying the villa advance?', answer: 'Rahul pays', ref: 'advance' },
      ],
    }),
    say(clock(6, 21, 30), M, 'love this group 🥹', false),
  ],
};
```

```ts
// packages/bench/scripts/gen-chats.ts
// Writes the generated chats. Run after changing a skeleton, the filler or the generator, and commit the output.
import { writeFileSync } from 'node:fs';
import { expandSkeleton, serializeChat } from '../src/generate.js';
import { GOA_2000 } from '../src/skeletons/goa-2000.js';
import { GOA_300 } from '../src/skeletons/goa-300.js';

for (const sk of [GOA_300, GOA_2000]) {
  const chat = expandSkeleton(sk);
  writeFileSync(new URL(`../chats/${sk.name}.jsonl`, import.meta.url), serializeChat(chat));
  console.log(`${sk.name}: ${chat.lines.length} lines`);
}
```

Add to `packages/bench/src/index.ts`:

```ts
export * from './generate.js';
export { GOA_300 } from './skeletons/goa-300.js';
export { GOA_2000 } from './skeletons/goa-2000.js';
```

Generate the two chat files (this runs the generator, not a test):

```bash
pnpm --filter @go/bench gen-chats
```
Expected output: `goa-300: 303 lines` and `goa-2000: 2002 lines` (messages plus the edit, delete and reaction rows).

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/bench/src/generate.ts packages/bench/src/skeletons packages/bench/scripts packages/bench/chats/goa-300.jsonl packages/bench/chats/goa-2000.jsonl packages/bench/src/index.ts packages/bench/src/__tests__/generate.test.ts
git commit -m "feat(bench): seeded generator and the 300 and 2,000 message Goa chats

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `generate.test.ts` passes (9 tests), including the byte-for-byte check of the committed chats.

---

### Task 4: Reading request bodies: prompt parts and the cache estimate

**Files:**
- Create: `packages/bench/src/requests.ts`
- Create: `packages/bench/src/cache-estimate.ts`
- Modify: `packages/bench/src/index.ts` (export both)
- Test: `packages/bench/src/__tests__/cache-estimate.test.ts`

**Interfaces:**
- Consumes: master §6.5 (breakpoint 1 on the system block, breakpoint 2 on the last full chat chunk of the first user message, `ttl: '1h'`).
- Produces:
  - `type Block`, `interface MessageBody`, `interface ProviderUsage`, `interface RecordedRequest { n; role: 'composer' | 'side'; body; realMs; simS; firstTokenMs?; doneMs?; usage?; error? }`, `class RequestLog { requests; composerModel; add(body, realMs, simS): RecordedRequest }`.
  - `canonical(v: unknown): string`, `positions(body): Position[]`, `promptParts(body): PromptParts` (`tools`, `system`, `chat`, `now`, `rounds`, `total`, `chatBlocks`, `rules`).
  - `minCacheableTokens(model: string): number`, `class CacheEstimator { estimate(body, simS): CacheEstimate }`, `CACHE_TTL_S = 3600`.
  - `type MissReason = 'first' | 'below_minimum' | 'ttl' | 'rules_changed' | 'delete' | 'edit' | 'fold' | 'drift'`, `interface ChatEvent { kind: 'edit' | 'delete'; realMs: number }`, `cacheTurns(requests, events, opts?): TurnCache[]`, `summarizeCache(turns): CacheSummary` (`status: 'ok' | 'not_cacheable_yet' | 'no_requests'`, `hitRate`, `hitRateAll`, `results`, `folds`).

How the estimate works. Each tool, system block and message block is a position, in render order. A position's hash covers everything before it (and the model; thinking settings for message positions), so equal hashes mean equal prefixes. A request reads the longest prefix that an earlier request wrote at a breakpoint, found by walking back at most 20 positions from each of this request's breakpoints, and still alive (TTL in chat time, refreshed by reads; the rules stay warm). It writes at every breakpoint whose prefix reaches the model's minimum. A first-round composer request that fails to read everything the previous one cached is a miss, and the miss gets a reason: `below_minimum`, `first`, `ttl` (more than an hour of chat time since the last request), `rules_changed`, `delete` or `edit` (one landed since the last turn), `fold` (fewer chat blocks than the turn before: the oldest chunks became one story block), else `drift`. `drift` and `rules_changed` mean something broke caching; Task 7 fails CI on them.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bench/src/__tests__/cache-estimate.test.ts
import { describe, expect, it } from 'vitest';
import { CacheEstimator, cacheTurns, minCacheableTokens, summarizeCache } from '../cache-estimate.js';
import { promptParts, type MessageBody, type RecordedRequest } from '../requests.js';

const RULES = 'Rules for Go, the friend in the trip chat. '.repeat(100);
const TOOLS = [{ name: 'stay_silent', description: 'End the turn without a message.', input_schema: { type: 'object', properties: {} } }];
const line = (s: number): string => `#${s} Priya: message number ${s} about the villa and the beach`;
const chunk = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, k) => line(from + k)).join('\n');

function body(o: { chunks: string[]; open?: string; model?: string; rules?: string; thinking?: unknown; rounds?: boolean }): MessageBody {
  const content = [
    ...o.chunks.map((text, k) => ({ type: 'text', text, ...(k === o.chunks.length - 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) })),
    { type: 'text', text: `Right now: nothing new.\n${o.open ?? ''}` },
  ];
  const messages: MessageBody['messages'] = [{ role: 'user', content }];
  if (o.rounds) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'trip', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Goa, 6 to 9 Nov', cache_control: { type: 'ephemeral', ttl: '1h' } }] });
  }
  return {
    model: o.model ?? 'claude-sonnet-5-5',
    max_tokens: 1024,
    tools: TOOLS,
    system: [{ type: 'text', text: o.rules ?? RULES, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    ...(o.thinking !== undefined ? { thinking: o.thinking } : {}),
    messages,
  };
}
const req = (n: number, b: MessageBody, simS: number, realMs = n * 1000): RecordedRequest => ({ n, role: 'composer', body: b, realMs, simS });

describe('prompt parts', () => {
  it('splits a request into rules, the cached chat, right now and tool rounds', () => {
    const p = promptParts(body({ chunks: [chunk(1, 25), chunk(26, 50)], open: chunk(51, 55), rounds: true }));
    expect(p.chatBlocks).toBe(2);
    expect(p.tools).toBeGreaterThan(0);
    expect(p.system).toBeGreaterThan(1000);
    expect(p.chat).toBeGreaterThan(p.now);
    expect(p.rounds).toBeGreaterThan(0);
    expect(p.total).toBe(p.tools + p.system + p.chat + p.now + p.rounds);
  });

  it('treats a first user message with no breakpoint as all "right now"', () => {
    const b = body({ chunks: [], open: chunk(1, 10) });
    expect(promptParts(b).chatBlocks).toBe(0);
    expect(promptParts(b).chat).toBe(0);
  });
});

describe('the cache estimate', () => {
  it('knows each model\'s minimum', () => {
    expect(minCacheableTokens('claude-sonnet-5-5')).toBe(512);
    expect(minCacheableTokens('claude-haiku-4-5')).toBe(4096);
    expect(minCacheableTokens('claude-sonnet-5')).toBe(1024);
  });

  it('a growing chat reads everything the last turn cached', () => {
    const turns = cacheTurns([
      req(0, body({ chunks: [chunk(1, 25)], open: chunk(26, 30) }), 0),
      req(1, body({ chunks: [chunk(1, 25)], open: chunk(26, 40) }), 60),
      req(2, body({ chunks: [chunk(1, 25), chunk(26, 50)], open: chunk(51, 55) }), 120),
    ], []);
    expect(turns.map((t) => t.result)).toEqual(['first', 'hit', 'hit']);
    const [t0, t1, t2] = turns;
    expect(t0?.estimate.readTokens).toBe(0);
    expect(t1?.estimate.readTokens).toBe(t0?.estimate.chatEndTokens);
    expect(t2?.estimate.readTokens).toBe(t1?.estimate.chatEndTokens);
    expect(t2?.estimate.writeTokens).toBe((t2?.estimate.chatEndTokens ?? 0) - (t2?.estimate.readTokens ?? 0));
    expect(t2?.sharedBlocks).toBeGreaterThanOrEqual(3);
    const s = summarizeCache(turns);
    expect(s.status).toBe('ok');
    expect(s.hitRate).toBeGreaterThan(0.6);
    expect(s.hitRateAll).toBeLessThan(s.hitRate ?? 0);
  });

  it('a tool round reads the turn\'s own chat', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], rounds: true }), 1)], []);
    expect(turns[1]?.firstRound).toBe(false);
    expect(turns[1]?.result).toBe('hit');
  });

  it('a delete inside the cached part shows as a miss with its reason, and the same change without a delete is drift', () => {
    const before = req(0, body({ chunks: [chunk(1, 25)], open: chunk(26, 30) }), 0, 1000);
    const rebuilt = body({ chunks: [chunk(1, 25).replace(`${line(3)}\n`, '')], open: chunk(26, 31) });
    const withDelete = cacheTurns([before, req(1, rebuilt, 30, 2000)], [{ kind: 'delete', realMs: 1500 }]);
    expect(withDelete[1]?.result).toBe('delete');
    expect(withDelete[1]?.estimate.readTokens).toBe(withDelete[1]?.estimate.rulesTokens);
    expect(summarizeCache(withDelete).results.delete).toBe(1);
    const noDelete = cacheTurns([before, req(1, rebuilt, 30, 2000)], []);
    expect(noDelete[1]?.result).toBe('drift');
  });

  it('below the minimum on Haiku 4.5 the prompt is not cacheable yet, never 0%', () => {
    const small = [req(0, body({ chunks: [chunk(1, 25)], model: 'claude-haiku-4-5' }), 0), req(1, body({ chunks: [chunk(1, 25)], open: line(26), model: 'claude-haiku-4-5' }), 30)];
    const turns = cacheTurns(small, []);
    expect(turns.map((t) => t.result)).toEqual(['below_minimum', 'below_minimum']);
    const s = summarizeCache(turns);
    expect(s.status).toBe('not_cacheable_yet');
    expect(s.hitRate).toBeNull();
    expect(s.hitRateAll).toBeNull();
    const sonnet = cacheTurns(small.map((r) => ({ ...r, body: { ...r.body, model: 'claude-sonnet-5-5' } })), []);
    expect(sonnet.map((t) => t.result)).toEqual(['first', 'hit']);
  });

  it('a quiet gap past the TTL misses the chat but keeps the rules warm', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], open: line(26) }), 7200)], []);
    expect(turns[1]?.result).toBe('ttl');
    expect(turns[1]?.estimate.readTokens).toBe(turns[1]?.estimate.rulesTokens);
    const cold = new CacheEstimator({ rulesStayWarm: false });
    cold.estimate(body({ chunks: [chunk(1, 25)] }), 0);
    expect(cold.estimate(body({ chunks: [chunk(1, 25)] }), 7200).readTokens).toBe(0);
  });

  it('a read refreshes the TTL, so a chat that keeps talking stays cached', () => {
    const turns = cacheTurns([0, 3000, 6000, 9000].map((s, n) => req(n, body({ chunks: [chunk(1, 25)], open: line(26 + n) }), s)), []);
    expect(turns.map((t) => t.result)).toEqual(['first', 'hit', 'hit', 'hit']);
  });

  it('a fold is a miss that reports the chat size before and after', () => {
    const turns = cacheTurns([
      req(0, body({ chunks: [chunk(1, 25), chunk(26, 50), chunk(51, 75)] }), 0),
      req(1, body({ chunks: ['The story so far: Goa 6 to 9 Nov, villa under 8k a head (#3, #12).', chunk(51, 75)] }), 60),
    ], []);
    expect(turns[1]?.result).toBe('fold');
    const s = summarizeCache(turns);
    expect(s.folds.length).toBe(1);
    expect(s.folds[0]?.afterChatTokens).toBeLessThan(s.folds[0]?.beforeChatTokens ?? 0);
  });

  it('changed rules break the cache and say so', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], rules: `${RULES} Today is Tuesday.` }), 60)], []);
    expect(turns[1]?.result).toBe('rules_changed');
    expect(turns[1]?.estimate.readTokens).toBe(0);
  });

  it('the provider looks back at most 20 blocks from a breakpoint', () => {
    const many = Array.from({ length: 26 }, (_, k) => chunk(k * 25 + 1, k * 25 + 25));
    const far = cacheTurns([req(0, body({ chunks: many.slice(0, 1) }), 0), req(1, body({ chunks: many }), 60)], []);
    expect(far[1]?.result).toBe('drift');
    expect(far[1]?.estimate.readTokens).toBe(far[1]?.estimate.rulesTokens);
    const near = cacheTurns([req(0, body({ chunks: many.slice(0, 1) }), 0), req(1, body({ chunks: many.slice(0, 5) }), 60)], []);
    expect(near[1]?.result).toBe('hit');
  });

  it('changing the thinking settings keeps the rules and loses the chat', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], thinking: { type: 'between_tools' } }), 60)], []);
    expect(turns[1]?.estimate.readTokens).toBe(turns[1]?.estimate.rulesTokens);
    expect(turns[1]?.result).toBe('drift');
  });

  it('no composer requests means no numbers, not zeros', () => {
    const s = summarizeCache([]);
    expect(s).toMatchObject({ status: 'no_requests', hitRate: null, hitRateAll: null, requests: 0 });
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/bench/src/requests.ts
/** What Go sent to the model: the exact request bodies in order, and how big each part of each prompt was. */
import { createHash } from 'node:crypto';

export type Block = Record<string, unknown>;

export interface MessageBody {
  model: string;
  system?: string | Block[];
  tools?: Block[];
  messages: Array<{ role: 'user' | 'assistant'; content: string | Block[] }>;
  thinking?: unknown;
  [key: string]: unknown;
}

export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface RecordedRequest {
  n: number;
  role: 'composer' | 'side';
  /** A copy of the body exactly as Go sent it. */
  body: MessageBody;
  /** Wall clock (Date.now()) when Go sent it. */
  realMs: number;
  /** Chat time in seconds: the `at` of the newest line delivered when Go sent it. */
  simS: number;
  firstTokenMs?: number;
  doneMs?: number;
  usage?: ProviderUsage;
  error?: string;
}

export class RequestLog {
  readonly requests: RecordedRequest[] = [];
  constructor(readonly composerModel: string) {}
  add(body: MessageBody, realMs: number, simS: number): RecordedRequest {
    const r: RecordedRequest = { n: this.requests.length, role: body.model === this.composerModel ? 'composer' : 'side', body: structuredClone(body), realMs, simS };
    this.requests.push(r);
    return r;
  }
}

export type Part = 'tools' | 'system' | 'chat' | 'now' | 'rounds';

export interface Position {
  part: Part;
  /** Hash of everything up to and including this block. */
  hash: string;
  bytes: number;
  tokens: number;
  breakpoint: boolean;
  ttlS: number;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** JSON with sorted keys, so equal content always gives equal bytes. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function withoutCacheControl(b: Block): Block {
  const { cache_control: _cacheControl, ...rest } = b;
  return rest;
}

const blocksOf = (content: string | Block[]): Block[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

export function positions(body: MessageBody): Position[] {
  const out: Position[] = [];
  let h = sha(`model:${body.model}`);
  const push = (part: Part, block: Block): void => {
    const cc = block['cache_control'] as { ttl?: unknown } | null | undefined;
    const c = canonical(withoutCacheControl(block));
    h = sha(`${h}\n${c}`);
    const bytes = Buffer.byteLength(c, 'utf8');
    out.push({ part, hash: h, bytes, tokens: Math.ceil(bytes / 4), breakpoint: cc !== undefined && cc !== null, ttlS: cc?.ttl === '1h' ? 3600 : 300 });
  };
  for (const t of body.tools ?? []) push('tools', t);
  for (const b of body.system === undefined ? [] : blocksOf(body.system)) push('system', b);
  // Thinking settings change the cache for messages, never for tools and system.
  h = sha(`${h}\nsettings:${canonical({ thinking: body.thinking ?? null })}`);
  body.messages.forEach((m, k) => {
    h = sha(`${h}\nrole:${m.role}`);
    const blocks = blocksOf(m.content);
    let lastBreakpoint = -1;
    if (k === 0) blocks.forEach((b, j) => { if (b['cache_control'] !== undefined && b['cache_control'] !== null) lastBreakpoint = j; });
    blocks.forEach((b, j) => push(k > 0 ? 'rounds' : j <= lastBreakpoint ? 'chat' : 'now', b));
  });
  return out;
}

export interface PromptParts {
  tools: number;
  system: number;
  chat: number;
  now: number;
  rounds: number;
  total: number;
  chatBlocks: number;
  /** Hash of tools and system together. */
  rules: string | null;
}

export function promptParts(body: MessageBody): PromptParts {
  const ps = positions(body);
  const sum = (p: Part): number => ps.filter((x) => x.part === p).reduce((s, x) => s + x.tokens, 0);
  const chat = ps.filter((x) => x.part === 'chat');
  const rules = ps.filter((x) => x.part === 'tools' || x.part === 'system');
  return {
    tools: sum('tools'), system: sum('system'), chat: sum('chat'), now: sum('now'), rounds: sum('rounds'),
    total: ps.reduce((s, x) => s + x.tokens, 0),
    chatBlocks: chat.length,
    rules: rules[rules.length - 1]?.hash ?? null,
  };
}
```

```ts
// packages/bench/src/cache-estimate.ts
/**
 * The cache hit rate the provider would give, computed from the request bodies Go sent.
 * Rules (research/agent-sdk.md §3.4): render order tools, system, messages; a read lands only
 * where an earlier request wrote a breakpoint; each breakpoint looks back at most 20 blocks;
 * nothing under the model's minimum is cached. Token counts are estimates (bytes / 4).
 */
import { positions, promptParts, type MessageBody, type PromptParts, type RecordedRequest } from './requests.js';

export function minCacheableTokens(model: string): number {
  if (model.includes('haiku-4-5')) return 4096;
  if (/sonnet-5-5|opus-5-5|fable-5/.test(model)) return 512;
  return 1024;
}

export interface CacheEstimate {
  totalTokens: number;
  readTokens: number;
  writeTokens: number;
  /** At least one breakpoint reached the model's minimum. */
  eligible: boolean;
  /** Tokens up to the end of the cached chat (breakpoint 2), when there is one. */
  chatEndTokens: number | null;
  /** Tokens of tools and system together. */
  rulesTokens: number;
}

interface Entry { expiresS: number; ttlS: number; rules: boolean }

export class CacheEstimator {
  private readonly entries = new Map<string, Entry>();
  private readonly lookback: number;
  private readonly rulesStayWarm: boolean;

  /** `rulesStayWarm`: other trips keep the shared rules cached in production, so a quiet trip still reads them. */
  constructor(opts: { lookback?: number; rulesStayWarm?: boolean } = {}) {
    this.lookback = opts.lookback ?? 20;
    this.rulesStayWarm = opts.rulesStayWarm ?? true;
  }

  estimate(body: MessageBody, simS: number): CacheEstimate {
    const ps = positions(body);
    const cum: number[] = [];
    let running = 0;
    for (const p of ps) {
      running += p.tokens;
      cum.push(running);
    }
    const tokensAt = (k: number): number => cum[k] ?? 0;
    const rulesEnd = ps.reduce((last, p, k) => (p.part === 'tools' || p.part === 'system' ? k : last), -1);
    const chatEnd = ps.reduce((last, p, k) => (p.part === 'chat' ? k : last), -1);
    const alive = (hash: string): boolean => {
      const e = this.entries.get(hash);
      return e !== undefined && ((this.rulesStayWarm && e.rules) || e.expiresS >= simS);
    };
    const breakpoints = ps.flatMap((p, k) => (p.breakpoint ? [k] : []));

    let best = -1;
    for (const b of breakpoints) {
      for (let k = b; k >= Math.max(0, b - this.lookback); k--) {
        if (alive(ps[k]?.hash ?? '')) {
          best = Math.max(best, k);
          break;
        }
      }
    }
    const readTokens = best >= 0 ? tokensAt(best) : 0;
    const read = best >= 0 ? this.entries.get(ps[best]?.hash ?? '') : undefined;
    if (read !== undefined) read.expiresS = simS + read.ttlS;

    const min = minCacheableTokens(body.model);
    let lastWritten = -1;
    for (const b of breakpoints) {
      const p = ps[b];
      if (p === undefined || tokensAt(b) < min) continue;
      this.entries.set(p.hash, { expiresS: simS + p.ttlS, ttlS: p.ttlS, rules: b <= rulesEnd });
      lastWritten = b;
    }
    return {
      totalTokens: running,
      readTokens,
      writeTokens: lastWritten > best ? tokensAt(lastWritten) - readTokens : 0,
      eligible: lastWritten >= 0,
      chatEndTokens: chatEnd >= 0 ? tokensAt(chatEnd) : null,
      rulesTokens: rulesEnd >= 0 ? tokensAt(rulesEnd) : 0,
    };
  }
}

export type MissReason = 'first' | 'below_minimum' | 'ttl' | 'rules_changed' | 'delete' | 'edit' | 'fold' | 'drift';
export type TurnResult = 'hit' | MissReason;
export interface ChatEvent { kind: 'edit' | 'delete'; realMs: number }

export interface TurnCache {
  n: number;
  realMs: number;
  simS: number;
  /** The turn's first model call (one user message); later rounds carry tool results. */
  firstRound: boolean;
  parts: PromptParts;
  estimate: CacheEstimate;
  hitRate: number;
  result: TurnResult;
  /** Leading positions identical to the previous first round. */
  sharedBlocks: number;
}

/** The TTL Go asks for (master §6.5). A miss after a shorter gap is never excused as "ttl". */
export const CACHE_TTL_S = 3600;

export function cacheTurns(requests: readonly RecordedRequest[], events: readonly ChatEvent[], opts: { rulesStayWarm?: boolean } = {}): TurnCache[] {
  const estimator = new CacheEstimator(opts.rulesStayWarm === undefined ? {} : { rulesStayWarm: opts.rulesStayWarm });
  const out: TurnCache[] = [];
  let prev: { realMs: number; turn: TurnCache; hashes: string[] } | null = null;
  let lastSimS: number | null = null;
  for (const r of requests) {
    if (r.role !== 'composer') continue;
    const estimate = estimator.estimate(r.body, r.simS);
    const parts = promptParts(r.body);
    const hashes = positions(r.body).map((p) => p.hash);
    const firstRound = r.body.messages.length === 1;
    let result: TurnResult;
    let sharedBlocks = 0;
    if (!estimate.eligible) {
      result = 'below_minimum';
    } else if (!firstRound) {
      result = estimate.readTokens >= (estimate.chatEndTokens ?? estimate.rulesTokens) ? 'hit' : 'drift';
    } else if (prev === null || !prev.turn.estimate.eligible) {
      result = 'first';
    } else {
      const p = prev;
      while (sharedBlocks < hashes.length && sharedBlocks < p.hashes.length && hashes[sharedBlocks] === p.hashes[sharedBlocks]) sharedBlocks++;
      const wanted = p.turn.estimate.chatEndTokens ?? p.turn.estimate.rulesTokens;
      const landed = (kind: ChatEvent['kind']): boolean => events.some((e) => e.kind === kind && e.realMs > p.realMs && e.realMs <= r.realMs);
      if (estimate.readTokens >= wanted) result = 'hit';
      else if (lastSimS !== null && r.simS - lastSimS > CACHE_TTL_S) result = 'ttl';
      else if (parts.rules !== p.turn.parts.rules) result = 'rules_changed';
      else if (landed('delete')) result = 'delete';
      else if (landed('edit')) result = 'edit';
      else if (parts.chatBlocks < p.turn.parts.chatBlocks) result = 'fold';
      else result = 'drift';
    }
    const turn: TurnCache = {
      n: r.n, realMs: r.realMs, simS: r.simS, firstRound, parts, estimate,
      hitRate: estimate.totalTokens > 0 ? estimate.readTokens / estimate.totalTokens : 0,
      result, sharedBlocks,
    };
    out.push(turn);
    lastSimS = r.simS;
    if (firstRound) prev = { realMs: r.realMs, turn, hashes };
  }
  return out;
}

export interface CacheSummary {
  requests: number;
  eligible: number;
  /** Read over total input, every composer request but the run's first. Null when there is nothing to count. */
  hitRate: number | null;
  /** The same over every composer request, the first included. */
  hitRateAll: number | null;
  status: 'ok' | 'not_cacheable_yet' | 'no_requests';
  results: Record<TurnResult, number>;
  folds: Array<{ n: number; beforeChatTokens: number; afterChatTokens: number }>;
}

export function summarizeCache(turns: readonly TurnCache[]): CacheSummary {
  const results: Record<TurnResult, number> = { hit: 0, first: 0, below_minimum: 0, ttl: 0, rules_changed: 0, delete: 0, edit: 0, fold: 0, drift: 0 };
  for (const t of turns) results[t.result]++;
  const folds: CacheSummary['folds'] = [];
  let prevFirst: TurnCache | null = null;
  for (const t of turns) {
    if (!t.firstRound) continue;
    if (t.result === 'fold' && prevFirst !== null) folds.push({ n: t.n, beforeChatTokens: prevFirst.parts.chat, afterChatTokens: t.parts.chat });
    prevFirst = t;
  }
  const rate = (ts: readonly TurnCache[]): number | null => {
    const total = ts.reduce((s, t) => s + t.estimate.totalTokens, 0);
    return total > 0 ? ts.reduce((s, t) => s + t.estimate.readTokens, 0) / total : null;
  };
  const eligible = turns.filter((t) => t.estimate.eligible).length;
  const base = { requests: turns.length, eligible, results, folds };
  if (turns.length === 0) return { ...base, status: 'no_requests', hitRate: null, hitRateAll: null };
  if (eligible === 0) return { ...base, status: 'not_cacheable_yet', hitRate: null, hitRateAll: null };
  return { ...base, status: 'ok', hitRate: rate(turns.slice(1)), hitRateAll: rate(turns) };
}
```

Add to `packages/bench/src/index.ts`:

```ts
export * from './requests.js';
export * from './cache-estimate.js';
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/bench/src/requests.ts packages/bench/src/cache-estimate.ts packages/bench/src/index.ts packages/bench/src/__tests__/cache-estimate.test.ts
git commit -m "feat(bench): read Go's request bodies and estimate the provider's cache hit, with a reason for every miss

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `cache-estimate.test.ts` passes (14 tests).

---

### Task 5: The stand-ins: the policy model, the recorder and the bench reflex

**Files:**
- Create: `packages/bench/src/policy-model.ts`
- Create: `packages/bench/src/recorder.ts`
- Create: `packages/bench/src/bench-reflex.ts`
- Modify: `packages/bench/package.json` (add `@go/brain` and `@go/contract`)
- Modify: `packages/bench/src/index.ts` (export the three)
- Test: `packages/bench/src/__tests__/stand-ins.test.ts`

**Interfaces:**
- Consumes: `Brain` from `@go/brain/app` (master §6.3; `Brain['reflex']` is `Reflex`, its `read(msg, ctx)` returns `ReflexRead`); `Message` from `@go/contract`; `addressesGo`, `CHATS_DIR`, `Chat`, `ChatLine`, `SayLine`, `ReflexLabel` (Task 1); `CacheEstimator`, `RequestLog`, `MessageBody`, `Block`, `ProviderUsage`, `RecordedRequest` (Task 4).
- Produces:
  - `chatLinesIn(body): Array<{ seq; name; text }>`, `POLICY_REPLY`, `POLICY_GREETING`, `SIDE_REPLY`, `class PolicyModel { log: RequestLog; client: FakeClient; decide(body, role): Decision }` with `new PolicyModel({ composerModel, simNow, firstTokenDelayMs? })`.
  - `interface ClientLike`, `recordingClient(real: ClientLike, log: RequestLog, simNow: () => number): ClientLike`.
  - `type Reflex`, `type ReflexRead`, `type ReflexMessage`, `allUnsure()`, `labelRead(line: SayLine): ReflexRead`, `messageKey(msg)`, `lineKey(line)`, `interface CountingReflex { read; reads: Map<string, number> }`, `class BenchReflex`, `countingReflex(inner)`, `interface JevRecording`, `loadRecording(name)`, `recordingFor(chat, recorded, jevModel, recordedAt)`, `writeRecording(name, rec)`.

The policy model reads the `#seq Name: text` lines (master §6.5) from the first user message, remembers the highest number it has seen, and answers `POLICY_REPLY` only when a new line from a person calls Go (`addressesGo`); the very first composer request with an empty chat gets `POLICY_GREETING`; anything else is a `stay_silent` tool call. Requests for any other model (Go's side passes, such as the fold and the after-turn pass) get `SIDE_REPLY` as plain text with no tool call. Usage comes from the cache estimate, so P1's `turns` rows carry the same numbers the bench computes, and Task 10 checks that the board agrees.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bench/src/__tests__/stand-ins.test.ts
import type { Message } from '@go/contract';
import { describe, expect, it } from 'vitest';
import { BenchReflex, allUnsure, countingReflex, labelRead, recordingFor, type Reflex, type ReflexMessage, type ReflexRead } from '../bench-reflex.js';
import { parseChat, type SayLine } from '../chat.js';
import { chatLinesIn, POLICY_GREETING, POLICY_REPLY, PolicyModel, SIDE_REPLY } from '../policy-model.js';
import { recordingClient, type ClientLike } from '../recorder.js';
import { RequestLog, type MessageBody } from '../requests.js';

const RULES = 'Rules for Go, the friend in the trip chat. '.repeat(60);
function composerBody(lines: string[], model = 'claude-sonnet-5-5'): MessageBody {
  return {
    model, max_tokens: 1024,
    system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [
      { type: 'text', text: lines.join('\n') === '' ? '(no messages yet)' : lines.join('\n'), cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'Right now: nothing.' },
    ] }],
  };
}
async function drain<T>(s: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of s) out.push(ev);
  return out;
}
const policy = (): PolicyModel => new PolicyModel({ composerModel: 'claude-sonnet-5-5', simNow: () => 0 });

function msg(personId: string, text: string): ReflexMessage {
  const m: Message = {
    message_id: `m_${text.length}`, seq: 1, updated_seq: 1, author: { kind: 'person', person_id: personId }, text,
    attachments: [], mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-06T13:30:00Z',
  };
  return m as ReflexMessage;
}
const ctx = {} as Parameters<Reflex['read']>[1];
const chat = parseChat('t', [
  JSON.stringify({ i: 0, at: 0, kind: 'say', person: 'p_rahul', text: '@Go flights Friday?', go_should_speak: true, reflex: { size: 'quick' } }),
  JSON.stringify({ i: 1, at: 5, kind: 'say', person: 'p_priya', text: "I'm veg btw", go_should_speak: false, quiet_ok: true, reflex: { fact: true, reaction: '✅' } }),
  JSON.stringify({ i: 2, at: 9, kind: 'say', person: 'p_kabir', text: 'wait', go_should_speak: 'either', reflex: { complete: false } }),
].join('\n'));
const say = (i: number): SayLine => chat.lines[i] as SayLine;

describe('the policy model', () => {
  it('greets an empty chat, answers a new call to Go once, and stays silent otherwise', async () => {
    const p = policy();
    const text = async (lines: string[]): Promise<unknown> => (await p.client.messages.stream(composerBody(lines)).finalMessage()).content[0];
    expect(await text([])).toMatchObject({ type: 'text', text: POLICY_GREETING });
    expect(await text(['#2 Rahul: Goa is on', '#3 Priya: @Go flights on Friday?'])).toMatchObject({ type: 'text', text: POLICY_REPLY });
    expect(await text(['#2 Rahul: Goa is on', '#3 Priya: @Go flights on Friday?', '#4 Go: On it! Checking now.'])).toMatchObject({ type: 'tool_use', name: 'stay_silent' });
    expect(await text(['#3 Priya: @Go flights on Friday?', '#5 Kabir: we need to go back there'])).toMatchObject({ type: 'tool_use', name: 'stay_silent' });
    expect(await text(['#5 Kabir: we need to go back there', '#6 Meher: ok go, and trains?'])).toMatchObject({ type: 'text', text: POLICY_REPLY });
  });

  it('gives a side pass a plain "nothing to add" with no tool call', async () => {
    const p = policy();
    const m = await p.client.messages.stream(composerBody(['#1 Rahul: @Go hi'], 'claude-haiku-4-5')).finalMessage();
    expect(m.content).toEqual([{ type: 'text', text: SIDE_REPLY, citations: null }]);
    expect(p.log.requests[0]?.role).toBe('side');
  });

  it('ends a tool round quietly', async () => {
    const b = composerBody(['#1 Rahul: @Go hi']);
    b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'trip', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] });
    expect((await policy().client.messages.stream(b).finalMessage()).stop_reason).toBe('tool_use');
  });

  it('streams the events a Messages loop reads, with usage from the cache estimate', async () => {
    const p = policy();
    const s = p.client.messages.stream(composerBody(['#1 Rahul: @Go flights?']));
    const events = await drain(s);
    expect(events.map((e) => e['type'])).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const first = await s.finalMessage();
    expect(first.usage.cache_read_input_tokens).toBe(0);
    expect(first.usage.cache_creation_input_tokens).toBeGreaterThan(0);
    const second = await p.client.messages.stream(composerBody(['#1 Rahul: @Go flights?'])).finalMessage();
    expect(second.usage.cache_read_input_tokens).toBeGreaterThan(0);
    expect(p.log.requests[0]?.firstTokenMs).toBeDefined();
    expect(p.log.requests[0]?.usage).toEqual(first.usage);
  });

  it('keeps its own copy of every body', () => {
    const p = policy();
    const b = composerBody(['#1 Rahul: hi']);
    p.client.messages.stream(b);
    b.model = 'changed';
    expect(p.log.requests[0]?.body.model).toBe('claude-sonnet-5-5');
  });

  it('reads chat lines from every text block and ignores other text', () => {
    const b = composerBody(['#1 Rahul: Goa is on', 'not a chat line', '#12 Priya Sharma: veg pls']);
    expect(chatLinesIn(b)).toEqual([{ seq: 1, name: 'Rahul', text: 'Goa is on' }, { seq: 12, name: 'Priya Sharma', text: 'veg pls' }]);
  });
});

describe('the recorder', () => {
  const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 };
  it('records the body, the first text, the end and the provider usage', async () => {
    const real: ClientLike = { messages: { stream: () => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start' }; yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }; },
      finalMessage: async () => ({ usage }),
    }) } };
    const log = new RequestLog('claude-sonnet-5-5');
    const s = recordingClient(real, log, () => 42).messages.stream(composerBody(['#1 Rahul: @Go hi']));
    await drain(s);
    await s.finalMessage();
    expect(log.requests[0]).toMatchObject({ role: 'composer', simS: 42, usage });
    expect(log.requests[0]?.firstTokenMs).toBeGreaterThanOrEqual(log.requests[0]?.realMs ?? Infinity);
  });
  it('records a failure and passes it on', async () => {
    const real: ClientLike = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() { throw new Error('overloaded'); }, finalMessage: async () => { throw new Error('overloaded'); } }) } };
    const log = new RequestLog('claude-sonnet-5-5');
    const s = recordingClient(real, log, () => 0).messages.stream(composerBody([]));
    await expect(drain(s)).rejects.toThrow('overloaded');
    expect(log.requests[0]?.error).toBe('overloaded');
  });
});

describe('the bench reflex', () => {
  it('turns hand labels into sure and unsure answers', () => {
    expect(labelRead(say(0))).toMatchObject({ forGo: { value: true, sure: true }, complete: { value: true, sure: true }, size: { value: 'quick', sure: true }, fact: { sure: false } });
    expect(labelRead(say(1))).toMatchObject({ forGo: { value: false, sure: true }, fact: { value: true, sure: true }, reaction: { value: '✅', sure: true } });
    expect(labelRead(say(2))).toMatchObject({ forGo: { value: null, sure: false }, complete: { value: false, sure: true } });
  });

  it('answers by who said what, says unsure about anything else, and counts reads', async () => {
    const r = new BenchReflex(chat.lines);
    expect(await r.read(msg('p_priya', "I'm veg btw"), ctx)).toEqual(labelRead(say(1)));
    expect(await r.read(msg('p_priya', 'something new'), ctx)).toEqual(allUnsure());
    expect(r.reads.get("p_priya\u0000I'm veg btw")).toBe(1);
  });

  it('prefers a recorded Jev read over the hand label', async () => {
    const recorded: ReflexRead = { ...allUnsure(), forGo: { value: false, sure: true } };
    const r = new BenchReflex(chat.lines, new Map([[0, recorded]]));
    expect(await r.read(msg('p_rahul', '@Go flights Friday?'), ctx)).toEqual(recorded);
  });

  it('wraps a live reflex, counts its reads and keeps the first answer for each line', async () => {
    const live = countingReflex(new BenchReflex(chat.lines));
    await live.read(msg('p_kabir', 'wait'), ctx);
    await live.read(msg('p_kabir', 'wait'), ctx);
    expect(live.reads.get('p_kabir\u0000wait')).toBe(2);
    expect(recordingFor(chat, live.recorded, 'jev-1.13.0', '2026-10-06T18:00:00Z')).toEqual({
      jev_model: 'jev-1.13.0', recorded_at: '2026-10-06T18:00:00Z', reads: { '2': labelRead(say(2)) },
    });
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

In `packages/bench/package.json`, replace the `dependencies` block with:

```json
  "dependencies": {
    "@go/brain": "workspace:*",
    "@go/contract": "workspace:*",
    "zod": "^4.0.0"
  },
```

```ts
// packages/bench/src/policy-model.ts
/**
 * The scripted policy model: the composer's model in the fast bench. It answers only when a line
 * it has not seen yet calls Go (or says hello to an empty chat) and otherwise calls stay_silent.
 * Side passes get a plain "nothing to add". It records every body and reports usage from the
 * cache estimate, so Go's turns rows carry the same numbers the bench computes.
 */
import { CacheEstimator } from './cache-estimate.js';
import { addressesGo } from './chat.js';
import { RequestLog, type Block, type MessageBody, type ProviderUsage, type RecordedRequest } from './requests.js';

export const LINE_RE = /^#(\d+) ([^:\n]{1,80}): (.*)$/gm;
export const POLICY_REPLY = 'On it! Checking now.';
export const POLICY_GREETING = "Hi all, I'm Go. Tell me what you need for the trip.";
export const SIDE_REPLY = 'Nothing to add.';

/** The `#seq Name: text` lines in the first user message, in order. */
export function chatLinesIn(body: MessageBody): Array<{ seq: number; name: string; text: string }> {
  const first = body.messages[0];
  if (first === undefined) return [];
  const texts = typeof first.content === 'string'
    ? [first.content]
    : first.content.filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? ''));
  const out: Array<{ seq: number; name: string; text: string }> = [];
  for (const t of texts) for (const m of t.matchAll(LINE_RE)) out.push({ seq: Number(m[1]), name: m[2] ?? '', text: m[3] ?? '' });
  return out;
}

export interface FakeUsage extends ProviderUsage {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation: null;
  inference_geo: null;
  server_tool_use: null;
  service_tier: 'standard';
}
export interface FakeMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Block[];
  stop_reason: 'end_turn' | 'tool_use';
  stop_sequence: null;
  stop_details: null;
  container: null;
  usage: FakeUsage;
}
export interface FakeStream extends AsyncIterable<Record<string, unknown>> {
  finalMessage(): Promise<FakeMessage>;
  abort(): void;
}
export interface FakeClient {
  messages: { stream(body: MessageBody, opts?: { signal?: AbortSignal }): FakeStream };
}
export type Decision = { kind: 'text'; text: string } | { kind: 'silent' };

export interface PolicyOptions {
  composerModel: string;
  /** Chat time in seconds, for the cache estimate's TTL. */
  simNow: () => number;
  /** Wait before the first event, to try Go with a slower model. Default 0. */
  firstTokenDelayMs?: number;
}

function streamEvents(m: FakeMessage): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: 'message_start', message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } },
  ];
  m.content.forEach((b, index) => {
    if (b['type'] === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b['text'] } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { ...b, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b['input'] ?? {}) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: m.stop_reason, stop_sequence: null, stop_details: null, container: null },
    usage: {
      input_tokens: m.usage.input_tokens, output_tokens: m.usage.output_tokens,
      cache_read_input_tokens: m.usage.cache_read_input_tokens, cache_creation_input_tokens: m.usage.cache_creation_input_tokens, server_tool_use: null,
    },
  });
  events.push({ type: 'message_stop' });
  return events;
}

export class PolicyModel {
  readonly log: RequestLog;
  readonly client: FakeClient;
  private readonly composerCache = new CacheEstimator();
  private readonly sideCache = new CacheEstimator();
  private lastSeenSeq = 0;
  private firstRounds = 0;

  constructor(private readonly o: PolicyOptions) {
    this.log = new RequestLog(o.composerModel);
    this.client = { messages: { stream: (body, opts) => this.stream(body, opts) } };
  }

  decide(body: MessageBody, role: RecordedRequest['role']): Decision {
    if (role === 'side') return { kind: 'text', text: SIDE_REPLY };
    if (body.messages.length > 1) return { kind: 'silent' };
    const isFirst = this.firstRounds === 0;
    this.firstRounds++;
    const lines = chatLinesIn(body).filter((l) => l.name !== 'Go');
    const fresh = lines.filter((l) => l.seq > this.lastSeenSeq);
    for (const l of fresh) this.lastSeenSeq = Math.max(this.lastSeenSeq, l.seq);
    if (isFirst && lines.length === 0) return { kind: 'text', text: POLICY_GREETING };
    return fresh.some((l) => addressesGo(l.text)) ? { kind: 'text', text: POLICY_REPLY } : { kind: 'silent' };
  }

  private stream(body: MessageBody, opts?: { signal?: AbortSignal }): FakeStream {
    const rec = this.log.add(body, Date.now(), this.o.simNow());
    const decision = this.decide(body, rec.role);
    const est = (rec.role === 'composer' ? this.composerCache : this.sideCache).estimate(body, rec.simS);
    const usage: FakeUsage = {
      input_tokens: est.totalTokens - est.readTokens - est.writeTokens,
      output_tokens: decision.kind === 'text' ? Math.ceil(Buffer.byteLength(decision.text, 'utf8') / 4) : 5,
      cache_read_input_tokens: est.readTokens,
      cache_creation_input_tokens: est.writeTokens,
      cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: 'standard',
    };
    const content: Block[] = decision.kind === 'text'
      ? [{ type: 'text', text: decision.text, citations: null }]
      : [{ type: 'tool_use', id: `toolu_bench_${rec.n}`, name: 'stay_silent', input: {} }];
    const message: FakeMessage = {
      id: `msg_bench_${rec.n}`, type: 'message', role: 'assistant', model: body.model, content,
      stop_reason: decision.kind === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, stop_details: null, container: null, usage,
    };
    const events = streamEvents(message);
    const delayMs = this.o.firstTokenDelayMs ?? 0;
    const finish = (): void => {
      rec.firstTokenMs ??= Date.now();
      rec.doneMs ??= Date.now();
      rec.usage = usage;
    };
    return {
      async *[Symbol.asyncIterator]() {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        for (const ev of events) {
          if (opts?.signal?.aborted === true) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
          }
          if (ev['type'] === 'content_block_delta' && rec.firstTokenMs === undefined) rec.firstTokenMs = Date.now();
          yield ev;
        }
        finish();
      },
      async finalMessage() {
        finish();
        return message;
      },
      abort() {},
    };
  }
}
```

```ts
// packages/bench/src/recorder.ts
/** Wraps the real model client for the live bench: records each body, the first text, the end and the provider's usage. */
import type { MessageBody, ProviderUsage, RequestLog } from './requests.js';

export interface StreamLike extends AsyncIterable<unknown> {
  finalMessage(): Promise<{ usage: ProviderUsage }>;
  abort?(): void;
}
export interface ClientLike {
  messages: { stream(body: MessageBody, opts?: unknown): StreamLike };
}

function isTextDelta(ev: unknown): boolean {
  if (ev === null || typeof ev !== 'object') return false;
  const e = ev as { type?: unknown; delta?: { type?: unknown } };
  return e.type === 'content_block_delta' && e.delta?.type === 'text_delta';
}

export function recordingClient(real: ClientLike, log: RequestLog, simNow: () => number): ClientLike {
  return {
    messages: {
      stream(body, opts) {
        const rec = log.add(body, Date.now(), simNow());
        let inner: StreamLike;
        try {
          inner = real.messages.stream(body, opts);
        } catch (e) {
          rec.error = (e as Error).message;
          throw e;
        }
        return {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const ev of inner) {
                if (rec.firstTokenMs === undefined && isTextDelta(ev)) rec.firstTokenMs = Date.now();
                yield ev;
              }
            } catch (e) {
              rec.error = (e as Error).message;
              throw e;
            }
            rec.doneMs ??= Date.now();
          },
          async finalMessage() {
            try {
              const m = await inner.finalMessage();
              rec.usage = m.usage;
              rec.doneMs ??= Date.now();
              return m;
            } catch (e) {
              rec.error = (e as Error).message;
              throw e;
            }
          },
          abort() {
            inner.abort?.();
          },
        };
      },
    },
  };
}
```

```ts
// packages/bench/src/bench-reflex.ts
/**
 * The reflex in the bench. The fast bench answers from recorded Jev reads when a recording exists,
 * else from the chat's hand labels. The live bench wraps the real reflex and records what it said.
 * Both count reads, so the replay knows when Go has read each message.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Brain } from '@go/brain/app';
import { CHATS_DIR, type Chat, type ChatLine, type ReflexLabel, type SayLine } from './chat.js';

export type Reflex = Brain['reflex'];
export type ReflexRead = Awaited<ReturnType<Reflex['read']>>;
export type ReflexMessage = Parameters<Reflex['read']>[0];
type ReflexCtx = Parameters<Reflex['read']>[1];

const yes = <T>(value: T): { value: T; sure: true } => ({ value, sure: true });
const unsure = (): { value: null; sure: false } => ({ value: null, sure: false });

export function allUnsure(): ReflexRead {
  return {
    forGo: unsure(), complete: unsure(), size: unsure(), taskId: unsure(), fact: unsure(),
    recordKind: unsure(), reaction: unsure(), risky: unsure(), opening: unsure(),
  };
}

/** What Jev should say about a line, from its labels. Speak true or false means sure; "either" means unsure. */
export function labelRead(line: SayLine): ReflexRead {
  const l: ReflexLabel = line.reflex ?? {};
  const speak = line.go_should_speak;
  return {
    forGo: l.for_go !== undefined ? yes(l.for_go) : speak === 'either' ? unsure() : yes(speak),
    complete: yes(l.complete ?? true),
    size: l.size !== undefined ? yes(l.size) : unsure(),
    taskId: unsure(),
    fact: l.fact === true ? yes(true) : unsure(),
    recordKind: unsure(),
    reaction: l.reaction !== undefined ? yes(l.reaction) : unsure(),
    risky: unsure(),
    opening: unsure(),
  };
}

export function messageKey(msg: ReflexMessage): string {
  const who = msg.author.kind === 'person' ? msg.author.person_id : msg.author.kind;
  return `${who}\u0000${msg.text ?? ''}`;
}
export function lineKey(line: SayLine): string {
  return `${line.person}\u0000${line.text}`;
}

export interface CountingReflex {
  read: Reflex['read'];
  /** How many times each message (person and text) was read. */
  readonly reads: Map<string, number>;
}

export class BenchReflex implements CountingReflex {
  readonly reads = new Map<string, number>();
  private readonly answers = new Map<string, ReflexRead>();

  constructor(lines: readonly ChatLine[], recorded?: ReadonlyMap<number, ReflexRead>) {
    for (const l of lines) {
      if (l.kind !== 'say' || l.person === 'go') continue;
      const key = lineKey(l);
      if (!this.answers.has(key)) this.answers.set(key, recorded?.get(l.i) ?? labelRead(l));
    }
  }

  // An arrow, so it works however the door calls it.
  read = async (msg: ReflexMessage, _ctx: ReflexCtx): Promise<ReflexRead> => {
    const key = messageKey(msg);
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return this.answers.get(key) ?? allUnsure();
  };
}

export function countingReflex(inner: Reflex): CountingReflex & { recorded: Map<string, ReflexRead> } {
  const reads = new Map<string, number>();
  const recorded = new Map<string, ReflexRead>();
  return {
    reads,
    recorded,
    read: async (msg, ctx) => {
      const r = await inner.read(msg, ctx);
      const key = messageKey(msg);
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (!recorded.has(key)) recorded.set(key, r);
      return r;
    },
  };
}

/** chats/<name>.jev.json: what real Jev said about each line, written by the live bench. */
export interface JevRecording {
  jev_model: string;
  recorded_at: string;
  reads: Record<string, ReflexRead>;
}

const recordingUrl = (name: string): URL => new URL(`${name}.jev.json`, CHATS_DIR);

function isRead(v: unknown): v is ReflexRead {
  if (v === null || typeof v !== 'object') return false;
  return Object.keys(allUnsure()).every((k) => {
    const s = (v as Record<string, unknown>)[k];
    return s !== null && typeof s === 'object' && typeof (s as { sure?: unknown }).sure === 'boolean';
  });
}

export function loadRecording(name: string): Map<number, ReflexRead> | null {
  const url = recordingUrl(name);
  if (!existsSync(url)) return null;
  const raw = JSON.parse(readFileSync(url, 'utf8')) as JevRecording;
  const out = new Map<number, ReflexRead>();
  for (const [k, v] of Object.entries(raw.reads)) {
    if (!isRead(v)) throw new Error(`${name}.jev.json: line ${k} is not a reflex read`);
    out.set(Number(k), v);
  }
  return out;
}

export function recordingFor(chat: Chat, recorded: ReadonlyMap<string, ReflexRead>, jevModel: string, recordedAt: string): JevRecording {
  const reads: Record<string, ReflexRead> = {};
  for (const l of chat.lines) {
    if (l.kind !== 'say' || l.person === 'go') continue;
    const r = recorded.get(lineKey(l));
    if (r !== undefined) reads[String(l.i)] = r;
  }
  return { jev_model: jevModel, recorded_at: recordedAt, reads };
}

export function writeRecording(name: string, rec: JevRecording): void {
  writeFileSync(recordingUrl(name), `${JSON.stringify(rec, null, 1)}\n`);
}
```

Add to `packages/bench/src/index.ts`:

```ts
export * from './policy-model.js';
export * from './recorder.js';
export * from './bench-reflex.js';
```

Refresh the lockfile:

```bash
pnpm install
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/bench/package.json pnpm-lock.yaml packages/bench/src/policy-model.ts packages/bench/src/recorder.ts packages/bench/src/bench-reflex.ts packages/bench/src/index.ts packages/bench/src/__tests__/stand-ins.test.ts
git commit -m "feat(bench): the scripted policy model, the request recorder and the bench reflex

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `stand-ins.test.ts` passes (12 tests). If the build fails on `@go/brain/app`, P1's package export is missing: see Interface notes 1.

---

### Task 6: Scoring a replay

**Files:**
- Create: `packages/bench/src/stats-math.ts`
- Create: `packages/bench/src/score.ts`
- Modify: `packages/bench/package.json` (add `@vestra/agent-sdk`)
- Modify: `packages/bench/src/index.ts` (export both)
- Test: `packages/bench/src/__tests__/score.test.ts`

**Interfaces:**
- Consumes: `computeAnthropicCostUsd(u: AnthropicUsage, model: string): number` from `@vestra/agent-sdk`; `Chat`, `SayLine`, `Speak`, `RecallProbe`, `addressesGo`, `chatCounts` (Task 1); `cacheTurns`, `summarizeCache`, `CacheSummary`, `ChatEvent`, `TurnCache` (Task 4); `promptParts`, `RecordedRequest` (Task 4).
- Produces: `percentile(values, p): number | null`; `interface Delivered`, `interface GoFrame { method; params; at }`, `interface RecallRun`, `interface ReplayRecord`, `groupsOf(chat): AskGroup[]`, `type PostKind`, `interface ChatScore`, `scoreReplay(rec: ReplayRecord): ChatScore`, `wrongSpeak(s: ChatScore): number`, `assertWallClock(frames, startedMs, endedMs): void`, `interface ProviderNumbers`, `providerNumbers(requests): ProviderNumbers`; constants `BURST_GAP_S = 5`, `FOLLOW_UP_MS = 8000`, `TYPING_WINDOW_MS = 10000`, `LEAK_GRACE_MS = 1000`.

The rules, in plain words:
- **Groups.** A person's lines at most 5 s apart are one group. A group expects Go to speak if any of its lines says `true`, may speak if any says `either`, else must stay quiet.
- **Posts.** `post_message` frames, one per `request_id` (a resend of the same write is one post; the Server stores one message). Each post is a `greeting` (before anyone spoke), a `duplicate` (the same text as the previous post with nothing new in between), `prompted` (a line that expects or allows speech landed since the previous post), a `follow_up` (within 8 s of a prompted post, different text), or `unprompted`.
- **Missed.** A group that expects speech and gets no post before the next such group lands.
- **Typing.** For each line that calls Go, the first `typing { on: true }` within 10 s of the line landing.
- **Reply.** For each answered group, from its latest line before the post to the post.
- **Wake.** Composer first rounds (one user message) over people's messages.
- **Leaks.** A deleted line's text (first 30 characters, when it has 12 or more) in a composer request that started more than a second after the delete.
- **Recall.** A probe passes when some result has the proof line's message number and contains the answer.

- [ ] **Step 1: Write the failing test**

```ts
// packages/bench/src/__tests__/score.test.ts
import { describe, expect, it } from 'vitest';
import { parseChat } from '../chat.js';
import type { MessageBody, RecordedRequest } from '../requests.js';
import { assertWallClock, groupsOf, providerNumbers, scoreReplay, wrongSpeak, type GoFrame, type ReplayRecord } from '../score.js';
import { percentile } from '../stats-math.js';

const T0 = 1_800_000_000_000;
const RULES = 'Rules for Go, the friend in the trip chat. '.repeat(60);
const chat = parseChat('s', [
  JSON.stringify({ i: 0, at: 0, kind: 'say', person: 'p_rahul', text: 'hello all', go_should_speak: false }),
  JSON.stringify({ i: 1, at: 60, kind: 'say', person: 'p_priya', text: '@Go flights to Goa on Friday?', go_should_speak: true }),
  JSON.stringify({ i: 2, at: 120, kind: 'say', person: 'p_meher', text: "I'm allergic to prawns", go_should_speak: false, quiet_ok: true }),
  JSON.stringify({ i: 3, at: 180, kind: 'say', person: 'p_kabir', text: 'lol', go_should_speak: false }),
  JSON.stringify({ i: 4, at: 240, kind: 'say', person: 'p_arjun', text: 'Dinner at Bua place on Sunday', go_should_speak: false }),
  JSON.stringify({ i: 5, at: 245, kind: 'delete', of: 4 }),
  JSON.stringify({ i: 6, at: 300, kind: 'say', person: 'p_rahul', text: 'what did Meher say?', go_should_speak: false }),
].join('\n'));
const at = (i: number): number => T0 + i * 1000;

function body(chatText: string): MessageBody {
  return {
    model: 'claude-sonnet-5-5', max_tokens: 1024,
    system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: chatText, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'Right now: nothing.' }] }],
  };
}
const requests: RecordedRequest[] = [
  { n: 0, role: 'composer', body: body('#2 Rahul: hello all\n#3 Priya: @Go flights to Goa on Friday?'), realMs: at(1) + 100, simS: 60, usage: { input_tokens: 700, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  { n: 1, role: 'composer', body: body('#2 Rahul: hello all\n#6 Arjun: Dinner at Bua place on Sunday'), realMs: at(6) + 100, simS: 300, usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 } },
];
const answer: GoFrame[] = [
  { method: 'typing', params: { trip_id: 't_goa', on: true }, at: at(1) + 120 },
  { method: 'post_message', params: { trip_id: 't_goa', request_id: 'rq1', text: 'On it! Checking now.' }, at: at(1) + 900 },
  { method: 'add_reaction', params: { trip_id: 't_goa', request_id: 'rq2', message_id: 'm2', emoji: '✅' }, at: at(2) + 50 },
  { method: 'add_reaction', params: { trip_id: 't_goa', request_id: 'rq3', message_id: 'm3', emoji: '✅' }, at: at(3) + 50 },
  { method: 'add_record_line', params: { trip_id: 't_goa', request_id: 'rq4' }, at: at(2) + 100 },
];

function record(over: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    chat, mode: 'fast', composerModel: 'claude-sonnet-5-5', reflexSource: 'labels', startedMs: T0 - 500, endedMs: T0 + 20_000,
    delivered: chat.lines.map((l) => ({ i: l.i, realMs: at(l.i), simS: l.at, ...(l.kind === 'say' ? { messageId: `m${l.i}`, seq: l.i + 2 } : {}) })),
    frames: answer, requests, recall: [], unreadByReflex: 0,
    ...over,
  };
}
const post = (requestId: string, text: string, when: number): GoFrame => ({ method: 'post_message', params: { trip_id: 't_goa', request_id: requestId, text }, at: when });
const hasBadNumber = (v: unknown): boolean =>
  typeof v === 'number' ? !Number.isFinite(v) : Array.isArray(v) ? v.some(hasBadNumber) : v !== null && typeof v === 'object' ? Object.values(v).some(hasBadNumber) : false;

describe('scoring a replay', () => {
  it('scores a clean ask: typing, the reply and one prompted post', () => {
    const s = scoreReplay(record());
    expect(s.typing).toMatchObject({ n: 1, p50Ms: 120, missing: 0 });
    expect(s.reply).toMatchObject({ n: 1, p50Ms: 900 });
    expect(s.speak).toMatchObject({ asks: 1, answered: 1, posts: 1, missed: [], unprompted: [], duplicates: [] });
    expect(s.speak.byKind.prompted).toBe(1);
    expect(wrongSpeak(s)).toBe(0);
  });

  it('allows a quiet reaction only where the line says so', () => {
    const s = scoreReplay(record());
    expect(s.quiet).toEqual({ reactions: 2, wrongReactions: [{ line: 3, emoji: '✅' }], recordLines: 1 });
  });

  it('a resend with the same request_id is one post', () => {
    const s = scoreReplay(record({ frames: [...answer, post('rq1', 'On it! Checking now.', at(1) + 2500)] }));
    expect(s.speak.posts).toBe(1);
  });

  it('the same text twice with nothing new in between is a duplicate', () => {
    const s = scoreReplay(record({ frames: [...answer, post('rq9', 'On it! Checking now.', at(1) + 950)] }));
    expect(s.speak.duplicates.length).toBe(1);
    expect(wrongSpeak(s)).toBe(1);
  });

  it('a quick second post is a follow-up; a post with nothing to answer is unprompted', () => {
    const s = scoreReplay(record({ frames: [...answer, post('rq5', 'Fares go up on Fridays, by the way.', at(3) + 500), post('rq6', 'Random thought', at(6) + 9000)] }));
    expect(s.speak.byKind.follow_up).toBe(1);
    expect(s.speak.unprompted).toEqual([{ at: at(6) + 9000, afterLine: 6, text: 'Random thought' }]);
  });

  it('names a missed ask', () => {
    const s = scoreReplay(record({ frames: answer.filter((f) => f.method !== 'post_message') }));
    expect(s.speak.missed).toEqual([{ line: 1, text: '@Go flights to Goa on Friday?' }]);
    expect(s.reply.p50Ms).toBeNull();
  });

  it('counts the model waking per person message', () => {
    expect(scoreReplay(record()).wake).toEqual({ turns: 2, messages: 6, rate: 2 / 6 });
  });

  it('deleted text in a later prompt is a leak; a prompt already in flight is not', () => {
    expect(scoreReplay(record()).leaks).toEqual([{ line: 4, requestN: 1 }]);
    const early = requests.map((r) => (r.n === 1 ? { ...r, realMs: at(5) + 500 } : r));
    expect(scoreReplay(record({ requests: early })).leaks).toEqual([]);
  });

  it('a recall probe passes only with the right message number and the answer', () => {
    const probe = { question: 'What is Meher allergic to?', answer: 'prawn', line: 2 };
    const right = scoreReplay(record({ recall: [{ probe, afterLine: 6, realMs: at(6) + 200, results: [{ text: "I'm allergic to prawns", messageId: 'm2', seq: 4 }] }] }));
    expect(right.recall).toMatchObject({ probes: 1, ran: true, passed: 1, failed: [] });
    const wrongSeq = scoreReplay(record({ recall: [{ probe, afterLine: 6, realMs: at(6) + 200, results: [{ text: "I'm allergic to prawns", messageId: 'm9', seq: 11 }] }] }));
    expect(wrongSeq.recall.passed).toBe(0);
    expect(wrongSeq.recall.failed[0]).toMatchObject({ line: 2, seq: 4 });
    const notRun = scoreReplay(record({ recall: [{ probe, afterLine: 6, realMs: at(6) + 200, results: null }] }));
    expect(notRun.recall.ran).toBe(false);
  });

  it("scores a chat with only Go's lines without a single NaN", () => {
    const onlyGo = parseChat('only-go', JSON.stringify({ i: 0, at: 0, kind: 'say', person: 'go', text: 'Hi all', go_should_speak: 'either' }));
    const s = scoreReplay(record({ chat: onlyGo, delivered: [], requests: [], frames: [post('rq1', "Hi all, I'm Go.", T0 + 100)] }));
    expect(s.wake.rate).toBeNull();
    expect(s.typing.p50Ms).toBeNull();
    expect(s.reply.p50Ms).toBeNull();
    expect(s.speak.byKind.greeting).toBe(1);
    expect(s.cache.status).toBe('no_requests');
    expect(s.messages.goLinesSkipped).toBe(1);
    expect(hasBadNumber(s)).toBe(false);
  });

  it('fails loudly when a frame was stamped by another clock', () => {
    expect(() => assertWallClock([{ method: 'typing', params: {}, at: 5 }], T0, T0 + 10_000)).toThrow(/not stamping frames with the wall clock/);
    expect(() => assertWallClock(answer, T0 - 500, T0 + 20_000)).not.toThrow();
  });

  it('groups a person\'s lines at most five seconds apart', () => {
    const burst = parseChat('b', [0, 1, 2, 9].map((t, i) => JSON.stringify({ i, at: t, kind: 'say', person: 'p_kabir', text: `line ${i}`, go_should_speak: i === 2 ? true : 'either' })).join('\n'));
    expect(groupsOf(burst).map((g) => ({ lines: g.lines, expect: g.expect }))).toEqual([{ lines: [0, 1, 2], expect: true }, { lines: [3], expect: 'either' }]);
  });

  it('reads the provider\'s own cache numbers, leaving out the run\'s first request', () => {
    expect(providerNumbers(requests)).toMatchObject({ requests: 2, cacheHit: 600 / 700 });
  });

  it('takes nearest-rank percentiles and ignores what is not a number', () => {
    expect(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 50)).toBe(5);
    expect(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([Number.NaN, 3], 50)).toBe(3);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

In `packages/bench/package.json`, replace the `dependencies` block with:

```json
  "dependencies": {
    "@go/brain": "workspace:*",
    "@go/contract": "workspace:*",
    "@vestra/agent-sdk": "workspace:*",
    "zod": "^4.0.0"
  },
```

```ts
// packages/bench/src/stats-math.ts
/** Nearest-rank percentile (p from 0 to 100). Null when there is nothing to rank; NaN and Infinity are skipped. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const k = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[k] ?? null;
}
```

```ts
// packages/bench/src/score.ts
/**
 * Scores one replay: did Go speak when it should and stay quiet when it should, how fast were the
 * first sign and the reply, how often did the model wake, how much of each prompt was cached,
 * did recall find the right message, did a deleted message come back. Latencies use the wall
 * clock at both ends; the cache uses chat time.
 */
import { computeAnthropicCostUsd } from '@vestra/agent-sdk';
import { cacheTurns, summarizeCache, type CacheSummary, type ChatEvent, type TurnCache } from './cache-estimate.js';
import { addressesGo, chatCounts, type Chat, type RecallProbe, type SayLine, type Speak } from './chat.js';
import { promptParts, type RecordedRequest } from './requests.js';
import { percentile } from './stats-math.js';

export interface Delivered {
  i: number;
  /** Wall clock just before the line was handed to the simulator. */
  realMs: number;
  simS: number;
  messageId?: string;
  seq?: number;
}
export interface GoFrame {
  method: string;
  params: Record<string, unknown>;
  /** Wall clock (Date.now()) when the simulator received it. */
  at: number;
}
export interface RecallRun {
  probe: RecallProbe;
  afterLine: number;
  realMs: number;
  /** Null when the memory lane is not registered. */
  results: Array<{ text: string; messageId: string; seq: number }> | null;
}
export interface ReplayRecord {
  chat: Chat;
  mode: 'fast' | 'live';
  composerModel: string;
  reflexSource: 'labels' | 'recorded' | 'live';
  startedMs: number;
  endedMs: number;
  delivered: Delivered[];
  frames: GoFrame[];
  requests: RecordedRequest[];
  recall: RecallRun[];
  /** People's lines the reflex never read within 3 s (the replay stopped waiting for them). */
  unreadByReflex: number;
}

export const BURST_GAP_S = 5;
export const FOLLOW_UP_MS = 8_000;
export const TYPING_WINDOW_MS = 10_000;
export const LEAK_GRACE_MS = 1_000;

export interface AskGroup { lines: number[]; person: string; expect: Speak }

/** A person's lines at most BURST_GAP_S apart are one group; Go answers the group, not each line. */
export function groupsOf(chat: Chat): AskGroup[] {
  const out: AskGroup[] = [];
  let last: SayLine | null = null;
  for (const l of chat.lines) {
    if (l.kind !== 'say' || l.person === 'go') continue;
    const g = out[out.length - 1];
    if (g !== undefined && last !== null && last.person === l.person && l.at - last.at <= BURST_GAP_S) g.lines.push(l.i);
    else out.push({ lines: [l.i], person: l.person, expect: false });
    last = l;
  }
  for (const g of out) {
    const speaks = g.lines.map((i) => (chat.lines[i] as SayLine).go_should_speak);
    g.expect = speaks.includes(true) ? true : speaks.includes('either') ? 'either' : false;
  }
  return out;
}

export type PostKind = 'prompted' | 'follow_up' | 'greeting' | 'duplicate' | 'unprompted';

export interface ChatScore {
  chat: string;
  mode: 'fast' | 'live';
  composerModel: string;
  reflexSource: ReplayRecord['reflexSource'];
  messages: { people: number; goLinesSkipped: number; edits: number; deletes: number; reactions: number; photos: number };
  wake: { turns: number; messages: number; rate: number | null };
  typing: { n: number; p50Ms: number | null; p90Ms: number | null; missing: number; withoutPost: number };
  reply: { n: number; p50Ms: number | null; p90Ms: number | null };
  speak: {
    asks: number;
    answered: number;
    missed: Array<{ line: number; text: string }>;
    posts: number;
    byKind: Record<PostKind, number>;
    unprompted: Array<{ at: number; afterLine: number | null; text: string }>;
    duplicates: Array<{ at: number; text: string }>;
  };
  quiet: { reactions: number; wrongReactions: Array<{ line: number; emoji: string }>; recordLines: number };
  cache: CacheSummary;
  turns: TurnCache[];
  prompt: { maxTokens: number | null; lastTokens: number | null; average: { tools: number; system: number; chat: number; now: number } | null };
  recall: { probes: number; ran: boolean; passed: number; afterFold: number; failed: Array<{ question: string; line: number; seq: number | null; got: string[] }> };
  leaks: Array<{ line: number; requestN: number }>;
  firstToken: { p50Ms: number | null; p90Ms: number | null };
  side: { requests: number; tokens: number };
  costUsd: number | null;
  unreadByReflex: number;
  durationMs: number;
}

export function wrongSpeak(s: ChatScore): number {
  return s.speak.missed.length + s.speak.unprompted.length + s.speak.duplicates.length;
}

/** One frame per request_id: a resend of the same write is the same write. */
function uniqueWrites(frames: readonly GoFrame[], method: string): GoFrame[] {
  const seen = new Set<string>();
  return frames
    .filter((f) => f.method === method)
    .filter((f) => {
      const id = f.params['request_id'];
      if (typeof id !== 'string') return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.at - b.at);
}

function postText(f: GoFrame): string {
  if (typeof f.params['text'] === 'string') return f.params['text'];
  const card = f.params['card'] as { fallback_text?: unknown } | undefined;
  return typeof card?.fallback_text === 'string' ? card.fallback_text : '';
}

/** Throws when the simulator stamped a frame with a clock other than the wall clock. */
export function assertWallClock(frames: readonly GoFrame[], startedMs: number, endedMs: number): void {
  for (const f of frames) {
    if (f.at < startedMs - 1000 || f.at > endedMs + 1000)
      throw new Error(`a ${f.method} frame at ${f.at} is outside the run (${startedMs} to ${endedMs}): the simulator is not stamping frames with the wall clock`);
  }
}

export interface ProviderNumbers {
  requests: number;
  cacheHit: number | null;
  firstTokenP50Ms: number | null;
  firstTokenP90Ms: number | null;
  costUsd: number | null;
}

/** The provider's own numbers from recorded usage: cache read over all input, every composer request but the first. */
export function providerNumbers(requests: readonly RecordedRequest[]): ProviderNumbers {
  const composer = requests.filter((r) => r.role === 'composer');
  const counted = composer.filter((r) => r.usage !== undefined).slice(1);
  let read = 0;
  let total = 0;
  for (const r of counted) {
    const u = r.usage;
    if (u === undefined) continue;
    const cr = u.cache_read_input_tokens ?? 0;
    read += cr;
    total += u.input_tokens + cr + (u.cache_creation_input_tokens ?? 0);
  }
  const firsts = composer.flatMap((r) => (r.firstTokenMs !== undefined ? [r.firstTokenMs - r.realMs] : []));
  return {
    requests: composer.length,
    cacheHit: total > 0 ? read / total : null,
    firstTokenP50Ms: percentile(firsts, 50),
    firstTokenP90Ms: percentile(firsts, 90),
    costUsd: costOf(requests),
  };
}

function costOf(requests: readonly RecordedRequest[]): number | null {
  let cost = 0;
  let priced = 0;
  for (const r of requests) {
    if (r.usage === undefined) continue;
    cost += computeAnthropicCostUsd({
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
    }, r.body.model);
    priced++;
  }
  return priced > 0 ? cost : null;
}

export function scoreReplay(rec: ReplayRecord): ChatScore {
  const { chat, frames, requests } = rec;
  const counts = chatCounts(chat);
  const deliveredByLine = new Map(rec.delivered.map((d) => [d.i, d]));
  const people = rec.delivered
    .flatMap((d) => {
      const line = chat.lines[d.i];
      return line !== undefined && line.kind === 'say' && line.person !== 'go' ? [{ line, d }] : [];
    })
    .sort((a, b) => a.d.realMs - b.d.realMs);

  // Posts, each classified.
  const posts = uniqueWrites(frames, 'post_message').map((f) => ({ at: f.at, text: postText(f) }));
  const byKind: Record<PostKind, number> = { prompted: 0, follow_up: 0, greeting: 0, duplicate: 0, unprompted: 0 };
  const unprompted: ChatScore['speak']['unprompted'] = [];
  const duplicates: ChatScore['speak']['duplicates'] = [];
  let prevAt = Number.NEGATIVE_INFINITY;
  let prevKind: PostKind | null = null;
  let prevText: string | null = null;
  const firstPersonMs = people[0]?.d.realMs;
  for (const p of posts) {
    const window = people.filter((x) => x.d.realMs > prevAt && x.d.realMs <= p.at);
    let kind: PostKind;
    if (firstPersonMs === undefined || p.at < firstPersonMs) kind = 'greeting';
    else if (window.length === 0 && prevText !== null && p.text === prevText) kind = 'duplicate';
    else if (window.some((x) => x.line.go_should_speak !== false)) kind = 'prompted';
    else if (prevKind !== null && prevKind !== 'unprompted' && prevKind !== 'duplicate' && p.at - prevAt <= FOLLOW_UP_MS && p.text !== prevText) kind = 'follow_up';
    else kind = 'unprompted';
    byKind[kind]++;
    if (kind === 'duplicate') duplicates.push({ at: p.at, text: p.text });
    if (kind === 'unprompted') {
      const before = people.filter((x) => x.d.realMs <= p.at);
      unprompted.push({ at: p.at, afterLine: before[before.length - 1]?.line.i ?? null, text: p.text });
    }
    prevAt = p.at;
    prevKind = kind;
    prevText = p.text;
  }

  // Asks: answered or missed, and how long the answer took.
  const asks = groupsOf(chat).filter((g) => g.expect === true);
  const missed: ChatScore['speak']['missed'] = [];
  const replyMs: number[] = [];
  asks.forEach((g, k) => {
    const start = deliveredByLine.get(g.lines[0] ?? -1)?.realMs;
    if (start === undefined) return;
    const next = asks[k + 1];
    const end = next === undefined ? Number.POSITIVE_INFINITY : deliveredByLine.get(next.lines[0] ?? -1)?.realMs ?? Number.POSITIVE_INFINITY;
    const answer = posts.find((p) => p.at >= start && p.at < end);
    const lastLine = g.lines[g.lines.length - 1] ?? -1;
    if (answer === undefined) {
      const l = chat.lines[lastLine];
      missed.push({ line: lastLine, text: l !== undefined && l.kind === 'say' ? l.text : '' });
      return;
    }
    const before = g.lines.map((i) => deliveredByLine.get(i)?.realMs).filter((t): t is number => t !== undefined && t <= answer.at);
    replyMs.push(answer.at - Math.max(...before));
  });

  // Typing: the first sign for each line that calls Go, and typing that led to nothing.
  const typingOn = frames.filter((f) => f.method === 'typing' && f.params['on'] === true).sort((a, b) => a.at - b.at);
  const typingMs: number[] = [];
  let typingMissing = 0;
  for (const x of people) {
    if (!addressesGo(x.line.text)) continue;
    const t = typingOn.find((f) => f.at >= x.d.realMs && f.at <= x.d.realMs + TYPING_WINDOW_MS);
    if (t === undefined) typingMissing++;
    else typingMs.push(t.at - x.d.realMs);
  }
  let withoutPost = 0;
  let lastOn = Number.NEGATIVE_INFINITY;
  for (const f of typingOn) {
    if (f.at - lastOn > FOLLOW_UP_MS && !posts.some((p) => p.at >= f.at && p.at <= f.at + 25_000)) withoutPost++;
    lastOn = f.at;
  }

  // Quiet actions.
  const lineByMessage = new Map(rec.delivered.flatMap((d) => (d.messageId !== undefined ? [[d.messageId, d.i] as const] : [])));
  const reactions = uniqueWrites(frames, 'add_reaction');
  const wrongReactions: ChatScore['quiet']['wrongReactions'] = [];
  for (const r of reactions) {
    const i = lineByMessage.get(String(r.params['message_id']));
    const l = i === undefined ? undefined : chat.lines[i];
    if (i !== undefined && l !== undefined && l.kind === 'say' && l.quiet_ok !== true) wrongReactions.push({ line: i, emoji: String(r.params['emoji'] ?? '') });
  }

  // Cache, prompt size and folds.
  const events: ChatEvent[] = rec.delivered.flatMap((d) => {
    const l = chat.lines[d.i];
    return l !== undefined && (l.kind === 'edit' || l.kind === 'delete') ? [{ kind: l.kind, realMs: d.realMs }] : [];
  });
  const turns = cacheTurns(requests, events);
  const cache = summarizeCache(turns);
  const firsts = turns.filter((t) => t.firstRound);
  const avg = (pick: (t: TurnCache) => number): number => Math.round(firsts.reduce((s, t) => s + pick(t), 0) / firsts.length);
  const firstRounds = requests.filter((r) => r.role === 'composer' && r.body.messages.length === 1).length;

  // Recall.
  const foldAt = turns.find((t) => t.result === 'fold')?.realMs ?? null;
  const failed: ChatScore['recall']['failed'] = [];
  let passed = 0;
  for (const run of rec.recall) {
    if (run.results === null) continue;
    const seq = deliveredByLine.get(run.probe.line)?.seq ?? null;
    const want = run.probe.answer.toLowerCase();
    if (seq !== null && run.results.some((x) => x.seq === seq && x.text.toLowerCase().includes(want))) passed++;
    else failed.push({ question: run.probe.question, line: run.probe.line, seq, got: run.results.slice(0, 3).map((x) => `#${x.seq} ${x.text}`.slice(0, 120)) });
  }

  // Leaks of deleted text into later prompts.
  const leaks: ChatScore['leaks'] = [];
  for (const l of chat.lines) {
    if (l.kind !== 'delete') continue;
    const d = deliveredByLine.get(l.i);
    const orig = chat.lines[l.of];
    if (d === undefined || orig === undefined || orig.kind !== 'say' || orig.text.length < 12) continue;
    const needle = JSON.stringify(Array.from(orig.text).slice(0, 30).join('')).slice(1, -1);
    const hit = requests.find((r) => r.role === 'composer' && r.realMs > d.realMs + LEAK_GRACE_MS && JSON.stringify(r.body).includes(needle));
    if (hit !== undefined) leaks.push({ line: l.of, requestN: hit.n });
  }

  const firstTokens = requests.flatMap((r) => (r.role === 'composer' && r.firstTokenMs !== undefined ? [r.firstTokenMs - r.realMs] : []));
  const side = requests.filter((r) => r.role === 'side');

  return {
    chat: chat.name,
    mode: rec.mode,
    composerModel: rec.composerModel,
    reflexSource: rec.reflexSource,
    messages: { people: counts.peopleMessages, goLinesSkipped: counts.goLines, edits: counts.edits, deletes: counts.deletes, reactions: counts.reactions, photos: counts.photos },
    wake: { turns: firstRounds, messages: people.length, rate: people.length > 0 ? firstRounds / people.length : null },
    typing: { n: typingMs.length, p50Ms: percentile(typingMs, 50), p90Ms: percentile(typingMs, 90), missing: typingMissing, withoutPost },
    reply: { n: replyMs.length, p50Ms: percentile(replyMs, 50), p90Ms: percentile(replyMs, 90) },
    speak: { asks: asks.length, answered: asks.length - missed.length, missed, posts: posts.length, byKind, unprompted, duplicates },
    quiet: { reactions: reactions.length, wrongReactions, recordLines: uniqueWrites(frames, 'add_record_line').length },
    cache,
    turns,
    prompt: {
      maxTokens: firsts.length > 0 ? Math.max(...firsts.map((t) => t.parts.total)) : null,
      lastTokens: firsts[firsts.length - 1]?.parts.total ?? null,
      average: firsts.length > 0 ? { tools: avg((t) => t.parts.tools), system: avg((t) => t.parts.system), chat: avg((t) => t.parts.chat), now: avg((t) => t.parts.now) } : null,
    },
    recall: {
      probes: rec.recall.length,
      ran: rec.recall.every((r) => r.results !== null),
      passed,
      afterFold: foldAt === null ? 0 : rec.recall.filter((r) => r.realMs > foldAt).length,
      failed,
    },
    leaks,
    firstToken: { p50Ms: percentile(firstTokens, 50), p90Ms: percentile(firstTokens, 90) },
    side: { requests: side.length, tokens: side.reduce((s, r) => s + promptParts(r.body).total, 0) },
    costUsd: costOf(requests),
    unreadByReflex: rec.unreadByReflex,
    durationMs: rec.endedMs - rec.startedMs,
  };
}
```

Add to `packages/bench/src/index.ts`:

```ts
export * from './stats-math.js';
export * from './score.js';
```

Refresh the lockfile:

```bash
pnpm install
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/bench/package.json pnpm-lock.yaml packages/bench/src/stats-math.ts packages/bench/src/score.ts packages/bench/src/index.ts packages/bench/src/__tests__/score.test.ts
git commit -m "feat(bench): score a replay: speak and quiet, first sign and reply, wake rate, cache, recall and leaks

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `score.test.ts` passes (14 tests).

---

### Task 7: The bars, the verdict and the summary

**Files:**
- Create: `packages/bench/bars.json`
- Create: `packages/bench/src/compare.ts`
- Create: `packages/bench/src/report-md.ts`
- Modify: `packages/bench/src/stats-math.ts` (add `fmtMs`, `fmtPct`, `fmtInt`)
- Modify: `packages/bench/src/index.ts` (export both)
- Test: `packages/bench/src/__tests__/compare.test.ts`

**Interfaces:**
- Consumes: `ChatScore`, `wrongSpeak`, `ProviderNumbers` (Task 6); `percentile` (Task 6).
- Produces: `Bars` (zod) and `loadBars(): Bars`; `interface Check { chat; name; value; bar; ok; note? }`, `interface Verdict { ok; checks }`, `compareFast(scores, bars.fast): Verdict`, `interface LiveRun { model; chat; score; provider }`, `liveChecks(run, bars.live): Check[]`, `compareLive(runs, bars.live, gateModel): Verdict & { byModel: Record<string, boolean> }`, `pickModel(runs, byModel): { model; why } | null`; `interface BenchReport`, `renderSummary(report): string`, `writeReport(report, outDir: URL, basename: string): void`; `fmtMs`, `fmtPct`, `fmtInt`.

The bars come from spec §1. The fast bench (scripted model) judges what Go controls: the first sign (typing p90 under 0.5 s), Go's own time to a reply (p90 under 1.5 s with an instant model), the cache estimate (85% or more on the 300 and 2,000 chats, where the prompt is in the spec's 20,000 to 50,000 token range; the 50 chat reports its number), the wake rate (under 25%), no cache breaks, no leaks, no wrong speak or wrong quiet action on the hand-labelled 50 chat, no duplicate post anywhere, every recall probe, and a fold on the 2,000 chat. Recall and the fold are reported but not required until `requireMemory` is set (Task 11 sets it once P2 is in `build`). The live bench judges the user-facing bars with real models: typing p90 under 0.5 s, reply p50 under 2.5 s and p90 under 5 s, the provider's own cache hit 85% or more, the wake rate, wrong speak on the 50 chat, and unprompted posts under 1 in 50 elsewhere (flagged for a person to review).

- [ ] **Step 1: Write the failing test**

```ts
// packages/bench/src/__tests__/compare.test.ts
import { describe, expect, it } from 'vitest';
import { compareFast, compareLive, loadBars, pickModel, type LiveRun } from '../compare.js';
import { renderSummary, type BenchReport } from '../report-md.js';
import type { ChatScore } from '../score.js';

const bars = loadBars();
const base: ChatScore = {
  chat: 'goa-50', mode: 'fast', composerModel: 'claude-sonnet-5-5', reflexSource: 'labels',
  messages: { people: 50, goLinesSkipped: 0, edits: 1, deletes: 1, reactions: 1, photos: 1 },
  wake: { turns: 10, messages: 50, rate: 0.2 },
  typing: { n: 6, p50Ms: 20, p90Ms: 40, missing: 0, withoutPost: 1 },
  reply: { n: 6, p50Ms: 300, p90Ms: 900 },
  speak: { asks: 6, answered: 6, missed: [], posts: 7, byKind: { prompted: 6, follow_up: 0, greeting: 1, duplicate: 0, unprompted: 0 }, unprompted: [], duplicates: [] },
  quiet: { reactions: 7, wrongReactions: [], recordLines: 2 },
  cache: { requests: 10, eligible: 10, hitRate: 0.9, hitRateAll: 0.82, status: 'ok', results: { hit: 9, first: 1, below_minimum: 0, ttl: 0, rules_changed: 0, delete: 0, edit: 0, fold: 0, drift: 0 }, folds: [] },
  turns: [],
  prompt: { maxTokens: 6200, lastTokens: 6100, average: { tools: 900, system: 3200, chat: 1100, now: 500 } },
  recall: { probes: 5, ran: true, passed: 5, afterFold: 0, failed: [] },
  leaks: [], firstToken: { p50Ms: null, p90Ms: null }, side: { requests: 3, tokens: 1200 }, costUsd: 0.012, unreadByReflex: 0, durationMs: 20_000,
};
const failed = (scores: ChatScore[]): string[] => compareFast(scores, bars.fast).checks.filter((c) => !c.ok).map((c) => `${c.chat}: ${c.name}`);

describe('the bars and the verdict', () => {
  it('holds the spec\'s numbers', () => {
    expect(bars.fast).toMatchObject({ typingP90Ms: 500, cacheHitMin: 0.85, wakeRateMax: 0.25, labelledChats: ['goa-50'] });
    expect(bars.live).toMatchObject({ typingP90Ms: 500, replyP50Ms: 2500, replyP90Ms: 5000, cacheHitMin: 0.85, wakeRateMax: 0.25, unpromptedShareMax: 0.02 });
  });

  it('passes a clean score', () => {
    expect(failed([base])).toEqual([]);
    expect(compareFast([base], bars.fast).ok).toBe(true);
  });

  it('judges the cache on long chats and only reports it on the short one', () => {
    const low = { ...base.cache, hitRate: 0.8 };
    expect(failed([{ ...base, chat: 'goa-300', cache: low }])).toEqual(['goa-300: cache hit']);
    const short = compareFast([{ ...base, cache: low }], bars.fast).checks.find((c) => c.name === 'cache hit');
    expect(short).toMatchObject({ ok: true, value: '80.0%' });
  });

  it('says "not cacheable yet" instead of 0% and does not fail on it', () => {
    const young = { ...base, chat: 'goa-300', cache: { ...base.cache, status: 'not_cacheable_yet' as const, hitRate: null, hitRateAll: null, eligible: 0 } };
    const c = compareFast([young], bars.fast).checks.find((x) => x.name === 'cache hit');
    expect(c).toMatchObject({ value: 'not cacheable yet', ok: true });
  });

  it('fails a wake rate over the bar and notes a chat with no messages from people', () => {
    expect(failed([{ ...base, wake: { turns: 14, messages: 50, rate: 0.28 } }])).toEqual(['goa-50: woke the model']);
    const none = compareFast([{ ...base, wake: { turns: 1, messages: 0, rate: null } }], bars.fast).checks.find((c) => c.name === 'woke the model');
    expect(none).toMatchObject({ ok: true, note: 'no messages from people' });
  });

  it('fails any wrong speak on the labelled chat, and only duplicates elsewhere', () => {
    const missed = { ...base.speak, missed: [{ line: 9, text: '@Go flights?' }], answered: 5 };
    expect(failed([{ ...base, speak: missed }])).toEqual(['goa-50: wrong speak (missed, unprompted, duplicate)']);
    expect(failed([{ ...base, chat: 'goa-300', speak: missed }])).toEqual([]);
    const dup = { ...base.speak, duplicates: [{ at: 1, text: 'On it! Checking now.' }] };
    expect(failed([{ ...base, chat: 'goa-300', speak: dup }])).toEqual(['goa-300: duplicate posts']);
    expect(failed([{ ...base, quiet: { ...base.quiet, wrongReactions: [{ line: 36, emoji: '✅' }] } }])).toEqual(['goa-50: wrong quiet reactions']);
  });

  it('fails a broken cache, a leak, an unread line and missing typing', () => {
    expect(failed([{ ...base, cache: { ...base.cache, results: { ...base.cache.results, drift: 1 } } }])).toEqual(['goa-50: cache breaks (drift, rules changed)']);
    expect(failed([{ ...base, leaks: [{ line: 15, requestN: 4 }] }])).toEqual(['goa-50: deleted text in a later prompt']);
    expect(failed([{ ...base, unreadByReflex: 2 }])).toEqual(['goa-50: lines the reflex never read']);
    expect(failed([{ ...base, typing: { ...base.typing, missing: 1 } }])).toEqual(['goa-50: typing missing']);
  });

  it('fails a recall miss; recall not run fails only once memory is required', () => {
    expect(failed([{ ...base, recall: { ...base.recall, passed: 4, failed: [{ question: 'q', line: 6, seq: 8, got: [] }] } }])).toEqual(['goa-50: recall']);
    const notRun = { ...base, recall: { ...base.recall, ran: false, passed: 0 } };
    expect(compareFast([notRun], { ...bars.fast, requireMemory: false }).ok).toBe(true);
    expect(compareFast([notRun], { ...bars.fast, requireMemory: true }).ok).toBe(false);
  });

  it('needs a fold on the fold chat once memory is required', () => {
    const big = { ...base, chat: 'goa-2000', recall: { ...base.recall, probes: 0, passed: 0 } };
    expect(compareFast([big], { ...bars.fast, requireMemory: false }).ok).toBe(true);
    expect(compareFast([big], { ...bars.fast, requireMemory: true }).checks.find((c) => c.name === 'folds')?.ok).toBe(false);
  });
});

describe('the live verdict and the model pick', () => {
  const provider = { requests: 10, cacheHit: 0.9, firstTokenP50Ms: 700, firstTokenP90Ms: 1100, costUsd: 0.05 };
  const run = (model: string, replyP50: number, over: Partial<LiveRun> = {}): LiveRun => ({
    model, chat: 'goa-50', score: { ...base, mode: 'live', composerModel: model, reply: { n: 6, p50Ms: replyP50, p90Ms: replyP50 * 2 } }, provider, ...over,
  });

  it('judges the gate model and picks the fastest model that passes every bar', () => {
    const sonnet = run('claude-sonnet-5-5', 1900);
    const haiku = run('claude-haiku-4-5', 1200, { provider: { ...provider, cacheHit: 0.4 } });
    const v = compareLive([sonnet, haiku], bars.live, 'claude-sonnet-5-5');
    expect(v.ok).toBe(true);
    expect(v.byModel).toEqual({ 'claude-sonnet-5-5': true, 'claude-haiku-4-5': false });
    expect(pickModel([sonnet, haiku], v.byModel)?.model).toBe('claude-sonnet-5-5');
    const both = compareLive([sonnet, run('claude-haiku-4-5', 1200)], bars.live, 'claude-haiku-4-5');
    expect(pickModel([sonnet, run('claude-haiku-4-5', 1200)], both.byModel)?.model).toBe('claude-haiku-4-5');
  });

  it('fails a slow reply on the live bench', () => {
    const v = compareLive([run('claude-sonnet-5-5', 3000)], bars.live, 'claude-sonnet-5-5');
    expect(v.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['reply p50', 'reply p90']);
  });
});

describe('the summary', () => {
  it('puts failures first and never prints NaN, undefined, Infinity or an em dash', () => {
    const scores = [base, { ...base, chat: 'goa-300', cache: { ...base.cache, hitRate: 0.8 } }, { ...base, chat: 'empty', wake: { turns: 0, messages: 0, rate: null }, typing: { n: 0, p50Ms: null, p90Ms: null, missing: 0, withoutPost: 0 }, prompt: { maxTokens: null, lastTokens: null, average: null }, costUsd: null }];
    const report: BenchReport = { schema: 'go.bench-report/v1', mode: 'fast', at: '2026-10-06T18:00:00Z', commit: 'abc1234', scores, verdict: compareFast(scores, bars.fast) };
    const md = renderSummary(report);
    expect(md).toContain('1 of');
    expect(md.indexOf('goa-300 | cache hit')).toBeLessThan(md.indexOf('goa-50 | typing p90'));
    for (const bad of ['NaN', 'undefined', 'Infinity', '—']) expect(md).not.toContain(bad);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```json
// packages/bench/bars.json
{
  "schema": "go.bench-bars/v1",
  "fast": {
    "typingP90Ms": 500,
    "goTimeP90Ms": 1500,
    "cacheHitMin": 0.85,
    "cacheChats": ["goa-300", "goa-2000"],
    "wakeRateMax": 0.25,
    "labelledChats": ["goa-50"],
    "recallMissMax": 0,
    "leakMax": 0,
    "brokenCacheMax": 0,
    "requireMemory": false,
    "foldChats": ["goa-2000"]
  },
  "live": {
    "typingP90Ms": 500,
    "replyP50Ms": 2500,
    "replyP90Ms": 5000,
    "cacheHitMin": 0.85,
    "wakeRateMax": 0.25,
    "labelledChats": ["goa-50"],
    "unpromptedShareMax": 0.02,
    "recallMissMax": 0
  }
}
```

Add to the end of `packages/bench/src/stats-math.ts`:

```ts
/** "40 ms", "1.92 s", or "n/a" when there is no number. */
export function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'n/a';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
/** "88.0%", or "n/a" when there is no number. */
export function fmtPct(x: number | null): string {
  return x === null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
/** "12,345". */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
```

```ts
// packages/bench/src/compare.ts
/** The bars from spec §1 and the verdict on a run: every check with its value, its bar, and why it passed when there was nothing to measure. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { wrongSpeak, type ChatScore, type ProviderNumbers } from './score.js';
import { fmtMs, fmtPct, percentile } from './stats-math.js';

const share = z.number().min(0).max(1);
export const Bars = z.object({
  schema: z.literal('go.bench-bars/v1'),
  fast: z.object({
    typingP90Ms: z.number().positive(),
    goTimeP90Ms: z.number().positive(),
    cacheHitMin: share,
    cacheChats: z.array(z.string()),
    wakeRateMax: share,
    labelledChats: z.array(z.string()),
    recallMissMax: z.int().nonnegative(),
    leakMax: z.int().nonnegative(),
    brokenCacheMax: z.int().nonnegative(),
    requireMemory: z.boolean(),
    foldChats: z.array(z.string()),
  }),
  live: z.object({
    typingP90Ms: z.number().positive(),
    replyP50Ms: z.number().positive(),
    replyP90Ms: z.number().positive(),
    cacheHitMin: share,
    wakeRateMax: share,
    labelledChats: z.array(z.string()),
    unpromptedShareMax: share,
    recallMissMax: z.int().nonnegative(),
  }),
});
export type Bars = z.infer<typeof Bars>;

export function loadBars(): Bars {
  return Bars.parse(JSON.parse(readFileSync(new URL('../bars.json', import.meta.url), 'utf8')));
}

export interface Check { chat: string; name: string; value: string; bar: string; ok: boolean; note?: string }
export interface Verdict { ok: boolean; checks: Check[] }

function adder(checks: Check[], chat: string) {
  return (name: string, value: string, bar: string, ok: boolean, note?: string): void => {
    checks.push({ chat, name, value, bar, ok, ...(note !== undefined ? { note } : {}) });
  };
}

export function compareFast(scores: readonly ChatScore[], b: Bars['fast']): Verdict {
  const checks: Check[] = [];
  for (const s of scores) {
    const add = adder(checks, s.chat);
    const typingBar = `p90 under ${b.typingP90Ms} ms`;
    if (s.typing.p90Ms === null) add('typing p90', 'n/a', typingBar, true, 'no message named Go');
    else add('typing p90', fmtMs(s.typing.p90Ms), typingBar, s.typing.p90Ms <= b.typingP90Ms);
    if (s.typing.missing > 0) add('typing missing', String(s.typing.missing), '0', false);

    const goTimeBar = `p90 under ${b.goTimeP90Ms} ms`;
    if (s.reply.p90Ms === null) add("Go's own time to reply", 'n/a', goTimeBar, true, 'no answered ask');
    else add("Go's own time to reply", fmtMs(s.reply.p90Ms), goTimeBar, s.reply.p90Ms <= b.goTimeP90Ms, 'the model is a stand-in that answers at once');

    const cacheBar = `${Math.round(b.cacheHitMin * 100)}% or more`;
    if (s.cache.status === 'not_cacheable_yet') add('cache hit', 'not cacheable yet', cacheBar, true, 'every prompt is under the model minimum');
    else if (s.cache.hitRate === null) add('cache hit', 'n/a', cacheBar, true, 'no composer turns to compare');
    else if (!b.cacheChats.includes(s.chat)) add('cache hit', fmtPct(s.cache.hitRate), cacheBar, true, 'reported only: this chat is shorter than the prompts the bar is for');
    else add('cache hit', fmtPct(s.cache.hitRate), cacheBar, s.cache.hitRate >= b.cacheHitMin);
    const broken = s.cache.results.drift + s.cache.results.rules_changed;
    add('cache breaks (drift, rules changed)', String(broken), `at most ${b.brokenCacheMax}`, broken <= b.brokenCacheMax);

    const wakeBar = `under ${Math.round(b.wakeRateMax * 100)}%`;
    if (s.wake.rate === null) add('woke the model', 'n/a', wakeBar, true, 'no messages from people');
    else add('woke the model', `${s.wake.turns} of ${s.wake.messages} (${fmtPct(s.wake.rate)})`, wakeBar, s.wake.rate < b.wakeRateMax);

    const wrong = wrongSpeak(s);
    if (b.labelledChats.includes(s.chat)) {
      add('wrong speak (missed, unprompted, duplicate)', String(wrong), '0', wrong === 0);
      add('wrong quiet reactions', String(s.quiet.wrongReactions.length), '0', s.quiet.wrongReactions.length === 0);
    } else {
      add('duplicate posts', String(s.speak.duplicates.length), '0', s.speak.duplicates.length === 0);
      add('wrong speak', String(wrong), 'for review', true, 'generated labels: listed for a person to review');
    }
    add('deleted text in a later prompt', String(s.leaks.length), `at most ${b.leakMax}`, s.leaks.length <= b.leakMax);
    if (s.unreadByReflex > 0) add('lines the reflex never read', String(s.unreadByReflex), '0', false);

    if (s.recall.probes > 0) {
      if (!s.recall.ran) add('recall', 'not run', `all ${s.recall.probes}`, !b.requireMemory, 'the memory lane is not registered');
      else add('recall', `${s.recall.passed} of ${s.recall.probes}`, `at most ${b.recallMissMax} missed`, s.recall.probes - s.recall.passed <= b.recallMissMax);
    }
    if (b.foldChats.includes(s.chat)) {
      const folded = s.cache.folds.length >= 1;
      if (b.requireMemory) add('folds', String(s.cache.folds.length), 'at least 1', folded);
      else add('folds', String(s.cache.folds.length), 'at least 1', true, 'not required until the memory lane lands');
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export interface LiveRun { model: string; chat: string; score: ChatScore; provider: ProviderNumbers }

export function liveChecks(run: LiveRun, b: Bars['live']): Check[] {
  const checks: Check[] = [];
  const add = adder(checks, `${run.chat} (${run.model})`);
  const s = run.score;
  const within = (name: string, v: number | null, max: number, bar: string): void => {
    if (v === null) add(name, 'n/a', bar, true, 'nothing to measure');
    else add(name, fmtMs(v), bar, v <= max);
  };
  within('typing p90', s.typing.p90Ms, b.typingP90Ms, `under ${b.typingP90Ms} ms`);
  within('reply p50', s.reply.p50Ms, b.replyP50Ms, `under ${b.replyP50Ms} ms`);
  within('reply p90', s.reply.p90Ms, b.replyP90Ms, `under ${b.replyP90Ms} ms`);
  const cacheBar = `${Math.round(b.cacheHitMin * 100)}% or more`;
  if (s.cache.status === 'not_cacheable_yet') add('cache hit (provider)', 'not cacheable yet', cacheBar, true, 'every prompt is under the model minimum');
  else if (run.provider.cacheHit === null) add('cache hit (provider)', 'n/a', cacheBar, true, 'no usage reported');
  else add('cache hit (provider)', fmtPct(run.provider.cacheHit), cacheBar, run.provider.cacheHit >= b.cacheHitMin);
  const wakeBar = `under ${Math.round(b.wakeRateMax * 100)}%`;
  if (s.wake.rate === null) add('woke the model', 'n/a', wakeBar, true, 'no messages from people');
  else add('woke the model', fmtPct(s.wake.rate), wakeBar, s.wake.rate < b.wakeRateMax);
  if (b.labelledChats.includes(run.chat)) add('wrong speak', String(wrongSpeak(s)), '0', wrongSpeak(s) === 0);
  else {
    const unpromptedShare = s.speak.posts > 0 ? s.speak.unprompted.length / s.speak.posts : null;
    const bar = `under 1 in ${Math.round(1 / b.unpromptedShareMax)}`;
    if (unpromptedShare === null) add('unprompted posts', 'n/a', bar, true, 'no posts');
    else add('unprompted posts', `${s.speak.unprompted.length} of ${s.speak.posts}`, bar, unpromptedShare < b.unpromptedShareMax, 'a person reviews each one');
  }
  if (s.recall.probes > 0) add('recall', s.recall.ran ? `${s.recall.passed} of ${s.recall.probes}` : 'not run', `at most ${b.recallMissMax} missed`, s.recall.ran && s.recall.probes - s.recall.passed <= b.recallMissMax);
  return checks;
}

export function compareLive(runs: readonly LiveRun[], b: Bars['live'], gateModel: string): Verdict & { byModel: Record<string, boolean> } {
  const byModel: Record<string, boolean> = {};
  const checks: Check[] = [];
  for (const r of runs) {
    const cs = liveChecks(r, b);
    checks.push(...cs);
    byModel[r.model] = (byModel[r.model] ?? true) && cs.every((c) => c.ok);
  }
  const gate = runs.filter((r) => r.model === gateModel);
  return { ok: gate.length > 0 && byModel[gateModel] === true, checks, byModel };
}

/** The fastest model (median of its chats' reply p50) among those that pass every live bar; cost breaks ties. */
export function pickModel(runs: readonly LiveRun[], byModel: Readonly<Record<string, boolean>>): { model: string; why: string } | null {
  const models = [...new Set(runs.map((r) => r.model))];
  if (models.length === 0) return null;
  const reply = (m: string): number | null => percentile(runs.filter((r) => r.model === m).flatMap((r) => (r.score.reply.p50Ms === null ? [] : [r.score.reply.p50Ms])), 50);
  const cost = (m: string): number => runs.filter((r) => r.model === m).reduce((s, r) => s + (r.provider.costUsd ?? 0), 0);
  const passing = models.filter((m) => byModel[m] === true);
  const pool = passing.length > 0 ? passing : models;
  const best = [...pool].sort((a, b) => (reply(a) ?? Number.MAX_VALUE) - (reply(b) ?? Number.MAX_VALUE) || cost(a) - cost(b))[0];
  if (best === undefined) return null;
  return {
    model: best,
    why: passing.length > 0
      ? `passes every live bar with the fastest reply p50 (${fmtMs(reply(best))})`
      : `no model passes every bar; this one has the fastest reply p50 (${fmtMs(reply(best))})`,
  };
}
```

```ts
// packages/bench/src/report-md.ts
/** The bench report: the full JSON, and a markdown summary for the CI job page. No em dashes, no NaN. */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { LiveRun, Verdict } from './compare.js';
import type { ChatScore } from './score.js';
import { fmtInt, fmtMs, fmtPct } from './stats-math.js';

export interface BenchReport {
  schema: 'go.bench-report/v1';
  mode: 'fast' | 'live';
  at: string;
  commit: string | null;
  scores: ChatScore[];
  live?: LiveRun[];
  pick?: { model: string; why: string } | null;
  /** What /stats.json said at the end of each fast replay, by chat. */
  boards?: Record<string, unknown>;
  verdict: Verdict;
}

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\n/g, ' ');

function chatSection(s: ChatScore): string[] {
  const c = s.cache.results;
  const out = [
    `## ${s.chat}${s.mode === 'live' ? ` (${s.composerModel})` : ''}`,
    '',
    `- Messages from people: ${s.messages.people} (${s.messages.edits} edits, ${s.messages.deletes} deletes, ${s.messages.reactions} reactions, ${s.messages.photos} photos). Reflex: ${s.reflexSource === 'labels' ? 'hand labels' : s.reflexSource === 'recorded' ? 'recorded Jev reads' : 'live Jev'}.`,
    `- Woke the model: ${s.wake.rate === null ? 'no messages from people' : `${s.wake.turns} times for ${s.wake.messages} messages (${fmtPct(s.wake.rate)})`}.`,
    `- Typing p50 / p90: ${fmtMs(s.typing.p50Ms)} / ${fmtMs(s.typing.p90Ms)} (${s.typing.n} lines named Go, ${s.typing.missing} missing, ${s.typing.withoutPost} typing with no post after it).`,
    `- ${s.mode === 'fast' ? "Go's own time to reply" : 'Reply'} p50 / p90: ${fmtMs(s.reply.p50Ms)} / ${fmtMs(s.reply.p90Ms)} (${s.reply.n} answers).`,
    `- Speaking: ${s.speak.asks} asks, ${s.speak.answered} answered; ${s.speak.posts} posts (prompted ${s.speak.byKind.prompted}, follow-up ${s.speak.byKind.follow_up}, greeting ${s.speak.byKind.greeting}, duplicate ${s.speak.byKind.duplicate}, unprompted ${s.speak.byKind.unprompted}).`,
    `- Quiet: ${s.quiet.reactions} reactions (${s.quiet.wrongReactions.length} where it was not fine), ${s.quiet.recordLines} record lines.`,
    `- Cache (estimate): ${s.cache.status === 'not_cacheable_yet' ? 'not cacheable yet' : `${fmtPct(s.cache.hitRate)} (with the first request ${fmtPct(s.cache.hitRateAll)})`} over ${s.cache.requests} composer requests. Hits ${c.hit}, first ${c.first}, below minimum ${c.below_minimum}, TTL ${c.ttl}, delete ${c.delete}, edit ${c.edit}, fold ${c.fold}, rules changed ${c.rules_changed}, drift ${c.drift}.`,
    `- Prompt: ${s.prompt.maxTokens === null ? 'no composer turns' : `largest ${fmtInt(s.prompt.maxTokens)} tokens, last ${fmtInt(s.prompt.lastTokens ?? 0)}`}${s.prompt.average === null ? '' : `; on average tools ${fmtInt(s.prompt.average.tools)}, system ${fmtInt(s.prompt.average.system)}, chat ${fmtInt(s.prompt.average.chat)}, right now ${fmtInt(s.prompt.average.now)}`}.`,
    `- Folds: ${s.cache.folds.length === 0 ? 'none' : s.cache.folds.map((f) => `request ${f.n}, chat ${fmtInt(f.beforeChatTokens)} to ${fmtInt(f.afterChatTokens)} tokens`).join('; ')}.`,
    `- Recall: ${s.recall.probes === 0 ? 'no probes' : !s.recall.ran ? 'not run (the memory lane is not registered)' : `${s.recall.passed} of ${s.recall.probes} (${s.recall.afterFold} asked after a fold)`}.`,
    `- Deleted text in a later prompt: ${s.leaks.length === 0 ? 'none' : s.leaks.map((l) => `line ${l.line} in request ${l.requestN}`).join(', ')}.`,
    `- Side passes: ${s.side.requests} requests, ${fmtInt(s.side.tokens)} tokens. Cost${s.mode === 'fast' ? ' (priced from the estimate)' : ''}: ${s.costUsd === null ? 'n/a' : `$${s.costUsd.toFixed(4)}`}. First word p50: ${fmtMs(s.firstToken.p50Ms)}. Ran for ${fmtMs(s.durationMs)}.`,
  ];
  if (s.speak.missed.length > 0) out.push('', '**Missed asks**', '', ...s.speak.missed.map((m) => `- line ${m.line}: ${m.text}`));
  if (s.speak.unprompted.length > 0) out.push('', '**Unprompted posts (for review)**', '', ...s.speak.unprompted.slice(0, 20).map((u) => `- after line ${u.afterLine ?? 'none'}: ${u.text.slice(0, 160)}`));
  if (s.quiet.wrongReactions.length > 0) out.push('', '**Reactions where a quiet action was not fine**', '', ...s.quiet.wrongReactions.map((w) => `- line ${w.line}: ${w.emoji}`));
  if (s.recall.failed.length > 0) out.push('', '**Recall misses**', '', ...s.recall.failed.map((f) => `- "${f.question}" wanted message #${f.seq ?? 'unknown'} (line ${f.line}); got ${f.got.length === 0 ? 'nothing' : f.got.join(' / ')}`));
  const firsts = s.turns.filter((t) => t.firstRound).slice(0, 40);
  if (firsts.length > 0) {
    out.push('', '| Request | Chat time | Tokens | Read | Result | Same blocks |', '|---|---|---|---|---|---|');
    for (const t of firsts) out.push(`| ${t.n} | ${fmtInt(t.simS)} s | ${fmtInt(t.estimate.totalTokens)} | ${fmtInt(t.estimate.readTokens)} | ${t.result} | ${t.sharedBlocks} |`);
  }
  return out;
}

export function renderSummary(r: BenchReport): string {
  const failing = r.verdict.checks.filter((c) => !c.ok);
  const lines = [
    `# Go replay bench (${r.mode})`,
    '',
    failing.length === 0 ? `**All ${r.verdict.checks.length} checks pass.**` : `**${failing.length} of ${r.verdict.checks.length} checks fail.**`,
    '',
    `Commit ${r.commit ?? 'unknown'}, ${r.at}. ${r.mode === 'fast' ? 'The model is a scripted stand-in, so reply times are Go\'s own time. Cache numbers are estimates from the request bodies.' : 'Real models and real Jev; cache numbers are the provider\'s own.'}`,
    '',
  ];
  if (r.live !== undefined && r.live.length > 0) {
    lines.push('## Models', '', '| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const x of r.live) {
      const s = x.score;
      lines.push(`| ${x.model} | ${x.chat} | ${fmtMs(s.reply.p50Ms)} | ${fmtMs(s.reply.p90Ms)} | ${fmtMs(x.provider.firstTokenP50Ms)} | ${fmtMs(s.typing.p90Ms)} | ${fmtPct(x.provider.cacheHit)} | ${fmtPct(s.cache.hitRate)} | ${x.provider.costUsd === null ? 'n/a' : `$${x.provider.costUsd.toFixed(4)}`} | ${s.speak.missed.length + s.speak.unprompted.length + s.speak.duplicates.length} |`);
    }
    lines.push('', r.pick ? `**Suggested COMPOSER_MODEL: ${r.pick.model}.** It ${r.pick.why}.` : 'No model to suggest.', '');
  }
  lines.push('## Checks', '', '| Chat | Check | Value | Bar | Result |', '|---|---|---|---|---|');
  for (const c of [...failing, ...r.verdict.checks.filter((x) => x.ok)]) {
    lines.push(`| ${cell(c.chat)} | ${cell(c.name)} | ${cell(c.value)} | ${cell(c.bar)} | ${c.ok ? 'pass' : '**FAIL**'}${c.note !== undefined ? ` (${cell(c.note)})` : ''} |`);
  }
  for (const s of r.scores) lines.push('', ...chatSection(s));
  return `${lines.join('\n')}\n`;
}

export function writeReport(r: BenchReport, outDir: URL, basename: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(new URL(`${basename}.json`, outDir), `${JSON.stringify(r, null, 1)}\n`);
  writeFileSync(new URL(`${basename}.md`, outDir), renderSummary(r));
}
```

Add to `packages/bench/src/index.ts`:

```ts
export * from './compare.js';
export * from './report-md.js';
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/bench/bars.json packages/bench/src/compare.ts packages/bench/src/report-md.ts packages/bench/src/stats-math.ts packages/bench/src/index.ts packages/bench/src/__tests__/compare.test.ts
git commit -m "feat(bench): the bars from the spec, the verdict, the model pick and the summary

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `compare.test.ts` passes (12 tests).

---

### Task 8: The board's numbers, from real turns

**Files:**
- Create: `apps/brain/src/db/migrations/6000_stats.sql`
- Create: `apps/brain/src/stats/sources.ts`
- Create: `apps/brain/src/stats/stats.ts`
- Test: `apps/brain/src/stats/__tests__/stats.test.ts`

**Interfaces:**
- Consumes: master §6.6 tables `turns` (`trip_id`, `started_at`, `typing_at`, `posted_at`, `model`, `input_tokens`, `cached_tokens`, `cost_usd`), `trip_events` (`type`, `payload`, `received_at`), `go_requests` (`method`, `params`, `error`, `sent_at`, `answered_at`), `trips`; `withSchema()` from `apps/brain/src/db/test-db.ts`; `pg` (`pg.Pool`).
- Produces:
  - `interface StatsWindow { from: Date; to: Date; hours: number }`, `interface StatValue { value: number | null; of?: number; note?: string }`, `interface StatsSource { name; label; order; good: 'zero' | 'low' | 'high'; read(pool, w): Promise<StatValue> }`, `class StatsRegistry { add(s); list() }`, `statsRegistry(brain: object): StatsRegistry`, `bookingsWithoutApproval: StatsSource` (name `payments_without_both_keys`).
  - `interface BoardNumbers`, `computeBoard(pool: pg.Pool, registry: StatsRegistry, o: { now: Date; hours: number }): Promise<BoardNumbers>`.
  - Table `bench_reports (chat text primary key, mode, summary jsonb, received_at)`.

How each number is read (all over turns whose `started_at` falls in the window, default the last 2 hours):
- **Go is typing**: `typing_at - started_at`, p50 and p90, over turns that sent typing.
- **Reply**: `posted_at - started_at`, p50 and p90, over turns that posted.
- **Cache**: sum of `cached_tokens` over sum of `input_tokens`, over turns that called a model. When no such turn reaches its model's minimum (512 on Sonnet 5.5, 4,096 on Haiku 4.5, else 1,024), the status is `not_cacheable_yet` and the number is null.
- **Woke the model**: turns that called a model, over people's `message.created` events received in the window.
- **Cost per trip**: sum of `cost_usd` over the trips with a turn in the window.
- **Sources** (other lanes add numbers): the default `payments_without_both_keys` counts, over all time, the `add_booking` requests Go sent and the Server accepted with an amount above zero, and how many of them carried no `approval_id`. P5 replaces it with the vault's own count (name `payments_without_both_keys`, which needs the Server's approval and the passkey), by calling `statsRegistry(brain).add(...)` in `registerMoney`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/stats/__tests__/stats.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { bookingsWithoutApproval, StatsRegistry, statsRegistry } from '../sources.js';
import { computeBoard } from '../stats.js';

const NOW = new Date('2026-10-08T18:00:00Z');
let db: Awaited<ReturnType<typeof withSchema>>;
let seq = 0;
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);
const registry = (): StatsRegistry => {
  const r = new StatsRegistry();
  r.add(bookingsWithoutApproval);
  return r;
};
const hasBadNumber = (v: unknown): boolean =>
  typeof v === 'number' ? !Number.isFinite(v) : Array.isArray(v) ? v.some(hasBadNumber) : v !== null && typeof v === 'object' && !(v instanceof Date) ? Object.values(v).some(hasBadNumber) : false;

async function turn(o: { id: string; trip?: string; ago: number; typingMs?: number; postedMs?: number; model?: string | null; input?: number; cached?: number; cost?: number }): Promise<void> {
  const started = minutesAgo(o.ago);
  const plus = (ms: number | undefined): Date | null => (ms === undefined ? null : new Date(started.getTime() + ms));
  await db.pool.query(
    'insert into turns (turn_id, trip_id, started_at, typing_at, posted_at, model, input_tokens, cached_tokens, output_tokens, cost_usd) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [o.id, o.trip ?? 't_goa', started, plus(o.typingMs), plus(o.postedMs), o.model === undefined ? 'claude-sonnet-5-5' : o.model, o.input ?? null, o.cached ?? null, o.model === null ? null : 20, o.cost ?? null],
  );
}
async function message(author: 'person' | 'go', ago: number): Promise<void> {
  seq += 1;
  const ev = {
    event_id: `ev_${seq}`, trip_id: 't_goa', seq, occurred_at: minutesAgo(ago).toISOString(), type: 'message.created',
    data: { message: { message_id: `m_${seq}`, author: author === 'person' ? { kind: 'person', person_id: 'p_priya' } : { kind: 'go' } } },
  };
  await db.pool.query('insert into trip_events (trip_id, seq, event_id, type, payload, received_at) values ($1, $2, $3, $4, $5, $6)', ['t_goa', seq, ev.event_id, ev.type, JSON.stringify(ev), minutesAgo(ago)]);
}
async function request(id: string, method: string, params: Record<string, unknown>, error: Record<string, unknown> | null = null): Promise<void> {
  await db.pool.query(
    'insert into go_requests (request_id, rpc_id, trip_id, method, params, result, error, sent_at, answered_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [id, `go_${id}`, 't_goa', method, JSON.stringify(params), error === null ? JSON.stringify({ booking_id: `b_${id}`, seq: 1 }) : null, error === null ? null : JSON.stringify(error), NOW, NOW],
  );
}

beforeAll(async () => {
  db = await withSchema();
  await db.pool.query("insert into trips (trip_id, last_seq, tz, created_at) values ('t_goa', 0, 'Asia/Kolkata', $1), ('t_two', 0, 'Asia/Kolkata', $1) on conflict do nothing", [NOW]);
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('truncate table turns, trip_events, go_requests, bench_reports cascade');
});

describe('the board numbers', () => {
  it('reads "no turns yet" in an empty window, with no NaN anywhere', async () => {
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n).toMatchObject({
      empty: true, turns: 0, messages: 0,
      typing: { n: 0, p50Ms: null, p90Ms: null }, reply: { n: 0, p50Ms: null, p90Ms: null },
      cache: { status: 'no_turns', hit: null }, wake: { turns: 0, messages: 0, rate: null },
      cost: { totalUsd: 0, perTripUsd: null, trips: 0 }, bench: [],
    });
    expect(n.sources).toEqual([{ name: 'payments_without_both_keys', label: 'Payments without both keys', good: 'zero', value: 0, of: 0, note: "All time. Bookings Go recorded without the Server's signed approval." }]);
    expect(n.window).toEqual({ hours: 2, from: '2026-10-08T16:00:00.000Z', to: '2026-10-08T18:00:00.000Z' });
    expect(hasBadNumber(n)).toBe(false);
  });

  it('computes typing, reply, cache, wake and cost from the window\'s turns', async () => {
    await turn({ id: 'tu_a', ago: 30, typingMs: 300, postedMs: 1900, input: 10_000, cached: 9_000, cost: 0.01 });
    await turn({ id: 'tu_b', ago: 60, typingMs: 500, postedMs: 2400, input: 8_000, cached: 7_200, cost: 0.008 });
    await turn({ id: 'tu_c', trip: 't_two', ago: 90, model: 'claude-haiku-4-5', input: 2_000, cached: 0, cost: 0.001 });
    await turn({ id: 'tu_d', ago: 180, typingMs: 100, postedMs: 900, input: 5_000, cached: 0, cost: 0.5 });
    await turn({ id: 'tu_e', ago: 10, model: null });
    for (let k = 0; k < 12; k++) await message('person', 5 + k);
    await message('go', 6);
    await message('go', 7);
    await message('person', 200);
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.empty).toBe(false);
    expect(n.turns).toBe(4);
    expect(n.messages).toBe(12);
    expect(n.typing).toEqual({ n: 2, p50Ms: 300, p90Ms: 500 });
    expect(n.reply).toEqual({ n: 2, p50Ms: 1900, p90Ms: 2400 });
    expect(n.cache).toEqual({ status: 'ok', hit: 16_200 / 20_000, turns: 3, eligibleTurns: 2 });
    expect(n.wake).toEqual({ turns: 3, messages: 12, rate: 0.25 });
    expect(n.cost.trips).toBe(2);
    expect(n.cost.totalUsd).toBeCloseTo(0.019, 6);
    expect(n.cost.perTripUsd).toBeCloseTo(0.0095, 6);
  });

  it('says not cacheable yet when every turn is under its model\'s minimum', async () => {
    await turn({ id: 'tu_h1', ago: 20, model: 'claude-haiku-4-5', input: 3_000, cached: 0 });
    await turn({ id: 'tu_h2', ago: 25, model: 'claude-haiku-4-5', input: 3_500, cached: 0 });
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.cache).toEqual({ status: 'not_cacheable_yet', hit: null, turns: 2, eligibleTurns: 0 });
  });

  it('counts bookings Go recorded without the Server\'s approval, over all time', async () => {
    await request('rq_1', 'add_booking', { trip_id: 't_goa', amount_minor: 5_420_000, currency: 'INR', approval_id: 'ap_01JA7Q3V8Z' });
    await request('rq_2', 'add_booking', { trip_id: 't_goa', amount_minor: 100_000, currency: 'INR' });
    await request('rq_3', 'add_booking', { trip_id: 't_goa', amount_minor: 100_000, currency: 'INR' }, { code: 409, message: 'conflict' });
    await request('rq_4', 'add_booking', { trip_id: 't_goa', amount_minor: 0, currency: 'INR' });
    await request('rq_5', 'post_message', { trip_id: 't_goa', text: 'Booked!' });
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.sources[0]).toMatchObject({ name: 'payments_without_both_keys', value: 1, of: 2 });
  });

  it('lets a lane replace a source by name, keeps them in order, and survives one that fails', async () => {
    const r = registry();
    r.add({ name: 'payments_without_both_keys', label: 'Payments without both keys', order: 100, good: 'zero', read: async () => ({ value: 0, of: 3, note: 'From the vault: approval and passkey on every payment.' }) });
    r.add({ name: 'broken', label: 'Broken', order: 50, good: 'low', read: async () => { throw new Error('boom'); } });
    const n = await computeBoard(db.pool, r, { now: NOW, hours: 2 });
    expect(n.sources.map((s) => s.name)).toEqual(['broken', 'payments_without_both_keys']);
    expect(n.sources[0]).toMatchObject({ value: null, note: 'Could not read this number.' });
    expect(n.sources[1]).toMatchObject({ value: 0, of: 3 });
  });

  it('gives each brain its own registry with the default source in it', () => {
    const a = {};
    const b = {};
    expect(statsRegistry(a)).toBe(statsRegistry(a));
    expect(statsRegistry(a)).not.toBe(statsRegistry(b));
    expect(statsRegistry(a).list().map((s) => s.name)).toEqual(['payments_without_both_keys']);
  });

  it('shows the latest bench report for each chat', async () => {
    await db.pool.query("insert into bench_reports (chat, mode, summary, received_at) values ('goa-300', 'live', $1, $2)", [JSON.stringify({ chat: 'goa-300', cacheHit: 0.91 }), minutesAgo(600)]);
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.bench).toEqual([{ chat: 'goa-300', mode: 'live', receivedAt: minutesAgo(600).toISOString(), summary: { chat: 'goa-300', cacheHit: 0.91 } }]);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the stats folder does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```sql
-- apps/brain/src/db/migrations/6000_stats.sql
-- The proof board's copy of the latest replay bench numbers, one row per chat.
create table if not exists bench_reports (
  chat text primary key,
  mode text not null check (mode in ('fast', 'live')),
  summary jsonb not null,
  received_at timestamptz not null default now()
);
```

```ts
// apps/brain/src/stats/sources.ts
/**
 * Numbers other lanes put on the proof board. A source has a name; adding one with a name that
 * exists replaces it, so P5 can swap the default payments number for the vault's own.
 */
import type pg from 'pg';

export interface StatsWindow { from: Date; to: Date; hours: number }
export interface StatValue { value: number | null; of?: number; note?: string }
export interface StatsSource {
  name: string;
  /** What the board shows above the number. No em dashes, no model or vendor names. */
  label: string;
  order: number;
  /** Which way is good: 'zero' means anything above 0 is a failure. */
  good: 'zero' | 'low' | 'high';
  read(pool: pg.Pool, w: StatsWindow): Promise<StatValue>;
}

export class StatsRegistry {
  private readonly byName = new Map<string, StatsSource>();
  add(s: StatsSource): void {
    this.byName.set(s.name, s);
  }
  list(): StatsSource[] {
    return [...this.byName.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
}

/** Bookings Go recorded and the Server accepted, with an amount, and how many lacked the Server's approval id. */
export const bookingsWithoutApproval: StatsSource = {
  name: 'payments_without_both_keys',
  label: 'Payments without both keys',
  order: 100,
  good: 'zero',
  async read(pool) {
    const { rows } = await pool.query<{ total: number; missing: number }>(
      `select count(*)::int as total,
              count(*) filter (where coalesce(params->>'approval_id', '') = '')::int as missing
         from go_requests
        where method = 'add_booking'
          and answered_at is not null
          and error is null
          and coalesce((params->>'amount_minor')::bigint, 0) > 0`,
    );
    const r = rows[0] ?? { total: 0, missing: 0 };
    return { value: r.missing, of: r.total, note: "All time. Bookings Go recorded without the Server's signed approval." };
  },
};

const registries = new WeakMap<object, StatsRegistry>();

/** The board's sources for one running brain. Lanes call this from their register function. */
export function statsRegistry(brain: object): StatsRegistry {
  let r = registries.get(brain);
  if (r === undefined) {
    r = new StatsRegistry();
    r.add(bookingsWithoutApproval);
    registries.set(brain, r);
  }
  return r;
}
```

```ts
// apps/brain/src/stats/stats.ts
/** The proof board's numbers, from the turns Go really ran in a window, plus the sources other lanes add. */
import type pg from 'pg';
import type { StatsRegistry, StatsWindow } from './sources.js';

/** The provider's minimum cacheable prompt (research/agent-sdk.md §3.4). */
export function minCacheableTokens(model: string): number {
  if (model.includes('haiku-4-5')) return 4096;
  if (/sonnet-5-5|opus-5-5|fable-5/.test(model)) return 512;
  return 1024;
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))] ?? null;
}

export interface BoardSource { name: string; label: string; good: 'zero' | 'low' | 'high'; value: number | null; of?: number; note?: string }
export interface BoardBench { chat: string; mode: string; receivedAt: string; summary: Record<string, unknown> }

export interface BoardNumbers {
  window: { hours: number; from: string; to: string };
  /** No turns in the window. */
  empty: boolean;
  turns: number;
  messages: number;
  typing: { n: number; p50Ms: number | null; p90Ms: number | null };
  reply: { n: number; p50Ms: number | null; p90Ms: number | null };
  cache: { status: 'ok' | 'not_cacheable_yet' | 'no_turns'; hit: number | null; turns: number; eligibleTurns: number };
  wake: { turns: number; messages: number; rate: number | null };
  cost: { totalUsd: number; perTripUsd: number | null; trips: number };
  sources: BoardSource[];
  bench: BoardBench[];
}

interface TurnRow {
  trip_id: string;
  started_at: Date;
  typing_at: Date | null;
  posted_at: Date | null;
  model: string | null;
  input_tokens: number | string | null;
  cached_tokens: number | string | null;
  cost_usd: number | string | null;
}

/** pg returns bigint and numeric as strings; anything unreadable counts as 0. */
const num = (v: number | string | null): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function computeBoard(pool: pg.Pool, registry: StatsRegistry, o: { now: Date; hours: number }): Promise<BoardNumbers> {
  const to = o.now;
  const from = new Date(to.getTime() - o.hours * 3_600_000);
  const window: StatsWindow = { from, to, hours: o.hours };
  const { rows } = await pool.query<TurnRow>(
    'select trip_id, started_at, typing_at, posted_at, model, input_tokens, cached_tokens, cost_usd from turns where started_at >= $1 and started_at < $2',
    [from, to],
  );
  const msgs = await pool.query<{ n: number }>(
    `select count(*)::int as n from trip_events
      where type = 'message.created' and received_at >= $1 and received_at < $2
        and coalesce(payload #>> '{data,message,author,kind}', payload #>> '{message,author,kind}') = 'person'`,
    [from, to],
  );
  const messages = msgs.rows[0]?.n ?? 0;

  const after = (at: Date | null, start: Date): number[] => {
    if (at === null) return [];
    const d = at.getTime() - start.getTime();
    return d >= 0 ? [d] : [];
  };
  const typingMs = rows.flatMap((r) => after(r.typing_at, r.started_at));
  const replyMs = rows.flatMap((r) => after(r.posted_at, r.started_at));

  const modelTurns = rows.filter((r) => r.model !== null);
  const input = modelTurns.reduce((s, r) => s + num(r.input_tokens), 0);
  const cached = modelTurns.reduce((s, r) => s + num(r.cached_tokens), 0);
  const eligibleTurns = modelTurns.filter((r) => num(r.input_tokens) >= minCacheableTokens(r.model ?? '')).length;
  const status: BoardNumbers['cache']['status'] = modelTurns.length === 0 ? 'no_turns' : eligibleTurns === 0 ? 'not_cacheable_yet' : 'ok';

  const totalUsd = rows.reduce((s, r) => s + num(r.cost_usd), 0);
  const trips = new Set(rows.map((r) => r.trip_id)).size;

  const sources: BoardSource[] = [];
  for (const s of registry.list()) {
    try {
      sources.push({ name: s.name, label: s.label, good: s.good, ...(await s.read(pool, window)) });
    } catch {
      sources.push({ name: s.name, label: s.label, good: s.good, value: null, note: 'Could not read this number.' });
    }
  }
  const bench = (await pool.query<{ chat: string; mode: string; summary: Record<string, unknown>; received_at: Date }>(
    'select chat, mode, summary, received_at from bench_reports order by chat',
  )).rows.map((b) => ({ chat: b.chat, mode: b.mode, receivedAt: b.received_at.toISOString(), summary: b.summary }));

  return {
    window: { hours: o.hours, from: from.toISOString(), to: to.toISOString() },
    empty: rows.length === 0,
    turns: rows.length,
    messages,
    typing: { n: typingMs.length, p50Ms: percentile(typingMs, 50), p90Ms: percentile(typingMs, 90) },
    reply: { n: replyMs.length, p50Ms: percentile(replyMs, 50), p90Ms: percentile(replyMs, 90) },
    cache: { status, hit: status === 'ok' && input > 0 ? cached / input : null, turns: modelTurns.length, eligibleTurns },
    wake: { turns: modelTurns.length, messages, rate: messages > 0 ? modelTurns.length / messages : null },
    cost: { totalUsd, perTripUsd: trips > 0 ? totalUsd / trips : null, trips },
    sources,
    bench,
  };
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/db/migrations/6000_stats.sql apps/brain/src/stats/sources.ts apps/brain/src/stats/stats.ts apps/brain/src/stats/__tests__/stats.test.ts
git commit -m "feat(stats): the proof board's numbers from real turns, and a registry other lanes add numbers to

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `stats.test.ts` passes (7 tests) against the CI Postgres.

---

### Task 9: The proof board: `/stats.json`, `/board` and the bench strip

**Files:**
- Create: `apps/brain/src/stats/board-html.ts`
- Create: `apps/brain/src/stats/routes.ts`
- Create: `apps/brain/src/stats/index.ts`
- Modify: `apps/brain/src/main.ts` (one import and one `registerStats` call, after `registerMemory`)
- Test: `apps/brain/src/stats/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `Brain` from `apps/brain/src/app.ts` (`env.ADMIN_TOKEN`, `pool`, `http`, `now`, `log`); `computeBoard`, `BoardNumbers` (Task 8); `statsRegistry` (Task 8); `withSchema()`.
- Produces: `registerStats(brain: StatsBrain): void` where `type StatsBrain = Pick<Brain, 'env' | 'pool' | 'http' | 'now' | 'log'>` (so it is a `RegisterLane`); `BenchSummary` (zod) for `POST /stats/bench`; `renderBoardPage(n)`, `renderTiles(n)`, `renderClosedPage(status)`; routes:
  - `GET /stats.json?token=&hours=` → `BoardNumbers` (no-store).
  - `GET /board?token=&hours=` → the stage page; refreshes its tiles every 5 s.
  - `GET /board/tiles?token=&hours=` → the tiles as an HTML fragment.
  - `POST /stats/bench` with `Authorization: Bearer <ADMIN_TOKEN>` and a `BenchSummary` body → 204; stores the latest numbers per chat.

The page is for the stage at 4:30 in the demo: big numbers on white, ink `#0A0A0A`, soft pastel tiles, Satoshi from Fontshare with a system font fallback. Each tile shows its bar from spec §1 and a dot (green when the bar holds, orange when it does not, grey with no data). The header says where the numbers come from ("From the last 2 hours of real turns") and says "No turns yet" before Go has run. The page never names a model or its vendor, never prints NaN, and sends no referrer, so the token in its URL never reaches the font host.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/stats/__tests__/routes.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { registerStats, type StatsBrain } from '../routes.js';
import { statsRegistry } from '../sources.js';

const NOW = new Date('2026-10-08T18:00:00Z');
const TOKEN = 'board-token-for-tests';
let db: Awaited<ReturnType<typeof withSchema>>;
let app: FastifyInstance;
let brain: StatsBrain;

function makeApp(adminToken: string | undefined): { app: FastifyInstance; brain: StatsBrain } {
  const a = Fastify();
  const b = { env: adminToken === undefined ? {} : { ADMIN_TOKEN: adminToken }, pool: db.pool, http: a, now: () => NOW, log: a.log } as unknown as StatsBrain;
  registerStats(b);
  return { app: a, brain: b };
}
async function turn(id: string, agoMin: number, typingMs: number, postedMs: number, input: number, cached: number): Promise<void> {
  const started = new Date(NOW.getTime() - agoMin * 60_000);
  await db.pool.query(
    'insert into turns (turn_id, trip_id, started_at, typing_at, posted_at, model, input_tokens, cached_tokens, output_tokens, cost_usd) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [id, 't_goa', started, new Date(started.getTime() + typingMs), new Date(started.getTime() + postedMs), 'claude-sonnet-5-5', input, cached, 30, 0.004],
  );
}
const summary = {
  chat: 'goa-300', mode: 'live', cacheHit: 0.91, cacheStatus: 'ok', wakeRate: 0.12, typingP90Ms: 180, replyP50Ms: 1900,
  recall: { passed: 7, probes: 7 }, wrongSpeak: 0, messages: 300, at: '2026-10-08T17:00:00Z',
};

beforeAll(async () => {
  db = await withSchema();
  await db.pool.query("insert into trips (trip_id, last_seq, tz, created_at) values ('t_goa', 0, 'Asia/Kolkata', $1) on conflict do nothing", [NOW]);
  ({ app, brain } = makeApp(TOKEN));
});
afterAll(async () => {
  await app.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('truncate table turns, trip_events, go_requests, bench_reports cascade');
});

describe('the proof board routes', () => {
  it('needs the token, and is off without ADMIN_TOKEN', async () => {
    expect((await app.inject({ method: 'GET', url: '/stats.json' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/stats.json?token=wrong' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/board' })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: `/stats.json?token=${TOKEN}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toMatchObject({ empty: true, window: { hours: 2 } });
    const off = makeApp(undefined);
    expect((await off.app.inject({ method: 'GET', url: `/stats.json?token=${TOKEN}` })).statusCode).toBe(503);
    await off.app.close();
  });

  it('says "No turns yet" before any turn, with no NaN, no em dash, no model names and no referrer', async () => {
    const res = await app.inject({ method: 'GET', url: `/board?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toContain('No turns yet');
    expect(res.body).toContain('<meta name="referrer" content="no-referrer">');
    expect(res.body).toContain('api.fontshare.com');
    for (const bad of ['NaN', 'undefined', 'Infinity', '—', 'Sonnet', 'Haiku', 'Claude', 'Anthropic', 'claude-']) expect(res.body, bad).not.toContain(bad);
  });

  it('shows the numbers from real turns, labelled with where they come from', async () => {
    await turn('tu_1', 20, 300, 1900, 10_000, 9_000);
    await turn('tu_2', 40, 400, 2300, 8_000, 7_200);
    const res = await app.inject({ method: 'GET', url: `/board/tiles?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('From the last 2 hours of real turns.');
    expect(res.body).toContain('0.3 s');
    expect(res.body).toContain('1.9 s');
    expect(res.body).toContain('90%');
    expect(res.body).not.toContain('claude-sonnet');
  });

  it('refreshes its tiles every 5 seconds with the same query', async () => {
    const res = await app.inject({ method: 'GET', url: `/board?token=${TOKEN}&hours=1` });
    expect(res.body).toContain("fetch('/board/tiles' + location.search");
    expect(res.body).toContain('setInterval(refresh, 5000)');
    expect(res.body).toContain('the last hour');
  });

  it('takes hours from 1 to 168 and falls back to 2 otherwise', async () => {
    const h = async (q: string): Promise<number> => (await app.inject({ method: 'GET', url: `/stats.json?token=${TOKEN}&hours=${q}` })).json().window.hours as number;
    expect(await h('24')).toBe(24);
    expect(await h('999')).toBe(2);
    expect(await h('1.5')).toBe(2);
  });

  it('stores a bench summary sent with the bearer token and shows it on the board', async () => {
    expect((await app.inject({ method: 'POST', url: '/stats/bench', payload: summary })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: { authorization: `Bearer ${TOKEN}` }, payload: { ...summary, cacheHit: 3 } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: { authorization: `Bearer ${TOKEN}` }, payload: summary })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: { authorization: `Bearer ${TOKEN}` }, payload: { ...summary, cacheHit: 0.93 } })).statusCode).toBe(204);
    const { rows } = await db.pool.query<{ n: number }>('select count(*)::int as n from bench_reports');
    expect(rows[0]?.n).toBe(1);
    const page = await app.inject({ method: 'GET', url: `/board?token=${TOKEN}` });
    expect(page.body).toContain('From the replay bench');
    expect(page.body).toContain('goa-300');
    expect(page.body).toContain('93%');
  });

  it('escapes text another lane gives it', async () => {
    statsRegistry(brain).add({ name: 'x', label: '<script>alert(1)</script>', order: 1, good: 'low', read: async () => ({ value: 3 }) });
    const res = await app.inject({ method: 'GET', url: `/board/tiles?token=${TOKEN}` });
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).not.toContain('<script>alert');
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the routes do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/stats/board-html.ts
/** The proof board page for the stage: big numbers, the bar under each, honest labels. */
import type { BoardNumbers } from './stats.js';

/** The bars from spec §1. */
export const BARS = { typingMs: 500, replyP50Ms: 2500, replyP90Ms: 5000, cacheHit: 0.85, wakeRate: 0.25 } as const;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const seconds = (ms: number | null): string | null => (ms === null ? null : ms < 100 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const pct = (x: number | null): string | null => (x === null ? null : `${Math.round(x * 100)}%`);
const usd = (x: number | null): string | null => (x === null ? null : `$${x < 1 ? x.toFixed(3) : x.toFixed(2)}`);

type Mark = 'good' | 'bad' | 'none';
interface Tile { label: string; value: string; detail: string; bar: string; mark: Mark }

function tileHtml(t: Tile, k: number): string {
  const numeric = /^\$?[\d.,]+\s?(%|s|ms)?$/.test(t.value);
  return `<section class="tile t${k % 5}"><div class="label"><span class="dot ${t.mark}"></span>${esc(t.label)}</div>`
    + `<div class="big${numeric ? '' : ' words'}">${esc(t.value)}</div><div class="detail">${esc(t.detail)}</div>`
    + `${t.bar === '' ? '' : `<div class="bar">${esc(t.bar)}</div>`}</section>`;
}

function benchLine(summary: Record<string, unknown>): string {
  const n = (k: string): number | null => (typeof summary[k] === 'number' && Number.isFinite(summary[k]) ? (summary[k] as number) : null);
  const recall = summary['recall'] as { passed?: unknown; probes?: unknown } | undefined;
  const parts: string[] = [];
  if (n('messages') !== null) parts.push(`${n('messages')} messages`);
  parts.push(summary['cacheStatus'] === 'not_cacheable_yet' ? 'cache not cacheable yet' : `cache ${pct(n('cacheHit')) ?? 'no data'}`);
  if (n('wakeRate') !== null) parts.push(`woke the model for ${pct(n('wakeRate'))}`);
  if (typeof recall?.passed === 'number' && typeof recall.probes === 'number' && recall.probes > 0) parts.push(`recall ${recall.passed} of ${recall.probes}`);
  if (n('replyP50Ms') !== null) parts.push(`reply p50 ${seconds(n('replyP50Ms'))}`);
  return parts.join(', ');
}

export function renderTiles(n: BoardNumbers): string {
  const when = n.window.hours === 1 ? 'the last hour' : `the last ${n.window.hours} hours`;
  const val = (s: string | null): string => s ?? (n.empty ? 'No turns yet' : 'No data yet');
  const updated = new Date(n.window.to).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const tiles: Tile[] = [
    {
      label: 'Go is typing',
      value: val(seconds(n.typing.p50Ms)),
      detail: n.typing.n === 0 ? 'after a message that names Go' : `p50; p90 ${seconds(n.typing.p90Ms) ?? 'no data'}, over ${n.typing.n} turns`,
      bar: 'Bar: under 0.5 s',
      mark: n.typing.p90Ms === null ? 'none' : n.typing.p90Ms < BARS.typingMs ? 'good' : 'bad',
    },
    {
      label: 'Reply',
      value: val(seconds(n.reply.p50Ms)),
      detail: n.reply.n === 0 ? "from the message to Go's answer" : `p50; p90 ${seconds(n.reply.p90Ms) ?? 'no data'}, over ${n.reply.n} answers`,
      bar: 'Bar: p50 under 2.5 s, p90 under 5 s',
      mark: n.reply.p50Ms === null || n.reply.p90Ms === null ? 'none' : n.reply.p50Ms < BARS.replyP50Ms && n.reply.p90Ms < BARS.replyP90Ms ? 'good' : 'bad',
    },
    {
      label: 'Prompt cache',
      value: n.cache.status === 'not_cacheable_yet' ? 'Not cacheable yet' : val(pct(n.cache.hit)),
      detail: n.cache.status === 'not_cacheable_yet' ? 'every prompt so far is under the caching minimum' : n.cache.turns === 0 ? 'share of each prompt read from cache' : `of the prompt read from cache, over ${n.cache.turns} turns`,
      bar: 'Bar: 85% or more',
      mark: n.cache.hit === null ? 'none' : n.cache.hit >= BARS.cacheHit ? 'good' : 'bad',
    },
    {
      label: 'Woke the model',
      value: val(pct(n.wake.rate)),
      detail: n.wake.messages === 0 ? 'messages that needed Go to think' : `${n.wake.turns} of ${n.wake.messages} messages`,
      bar: 'Bar: under 25%',
      mark: n.wake.rate === null ? 'none' : n.wake.rate < BARS.wakeRate ? 'good' : 'bad',
    },
    {
      label: 'Cost per trip',
      value: val(usd(n.cost.perTripUsd)),
      detail: n.cost.trips === 0 ? 'model cost per active trip' : `${n.cost.trips} trips, ${usd(n.cost.totalUsd) ?? '$0'} in all`,
      bar: '',
      mark: 'none',
    },
    ...n.sources.map((s): Tile => ({
      label: s.label,
      value: s.value === null ? 'No data yet' : String(s.value),
      detail: [s.of === undefined ? '' : s.of === 0 ? 'Nothing to count yet.' : `Out of ${s.of}.`, s.note ?? ''].filter((x) => x !== '').join(' '),
      bar: s.good === 'zero' ? 'Bar: zero' : '',
      mark: s.value === null || s.good !== 'zero' ? 'none' : s.value === 0 ? 'good' : 'bad',
    })),
  ];
  const header = `<header><div class="eyebrow">Go, live numbers</div>`
    + `<h1>${n.empty ? `No turns yet in ${when}.` : `From ${when} of real turns.`}</h1>`
    + `<p class="sub">${n.empty ? "Numbers appear after Go's first turn." : `${n.turns} turns, ${n.messages} messages from people. Updated ${esc(updated)} IST.`}</p></header>`;
  const bench = n.bench.length === 0
    ? ''
    : `<section class="bench"><h2>From the replay bench</h2><ul>${n.bench.map((b) => `<li><strong>${esc(b.chat)}</strong> ${esc(benchLine(b.summary))}<span class="when">${esc(b.mode)} run, ${esc(b.receivedAt.slice(0, 16).replace('T', ' '))} UTC</span></li>`).join('')}</ul></section>`;
  return `${header}<div class="grid">${tiles.map(tileHtml).join('')}</div>${bench}`;
}

const STYLE = `
:root { --ink: #0A0A0A; --muted: #5C5C5C; --line: #EDEDED; --mint: #E3F6EA; --lilac: #EEE8FB; --sky: #E4F0FB; --butter: #FBF5DC; --peach: #FDECDF; --good: #1F9D57; --bad: #D9480F; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #FFFFFF; color: var(--ink); }
body { font-family: 'Satoshi', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 1280px; margin: 0 auto; padding: 56px 40px 24px; }
header { margin-bottom: 36px; }
.eyebrow { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
h1 { font-size: clamp(32px, 4vw, 52px); font-weight: 700; letter-spacing: -0.02em; margin: 10px 0 6px; }
.sub { color: var(--muted); font-size: 18px; margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
.tile { border-radius: 28px; padding: 28px 28px 24px; min-height: 230px; display: flex; flex-direction: column; }
.t0 { background: var(--mint); } .t1 { background: var(--lilac); } .t2 { background: var(--sky); } .t3 { background: var(--butter); } .t4 { background: var(--peach); }
.label { font-size: 17px; font-weight: 500; display: flex; align-items: center; gap: 10px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #C9C9C9; flex: none; }
.dot.good { background: var(--good); } .dot.bad { background: var(--bad); }
.big { font-size: clamp(48px, 6.5vw, 96px); font-weight: 900; letter-spacing: -0.04em; line-height: 1; margin: 22px 0 12px; font-variant-numeric: tabular-nums; }
.big.words { font-size: clamp(28px, 3.4vw, 44px); letter-spacing: -0.02em; }
.detail { font-size: 16px; color: var(--muted); }
.bar { margin-top: auto; padding-top: 14px; font-size: 14px; color: var(--muted); }
.bench { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 22px; }
.bench h2 { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
.bench ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; font-size: 18px; }
.bench strong { margin-right: 8px; }
.when { color: var(--muted); font-size: 15px; margin-left: 10px; }
.status { text-align: center; color: var(--muted); font-size: 14px; min-height: 20px; }
@media (max-width: 600px) { main { padding: 32px 16px; } .tile { min-height: 0; } }
`;

function shell(body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Go live numbers</title>'
    + '<link rel="preconnect" href="https://api.fontshare.com"><link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&amp;display=swap">'
    + `<style>${STYLE}</style></head><body>${body}</body></html>`;
}

/** The full page. Its script swaps in fresh tiles every 5 s and keeps the last good numbers if a read fails. */
export function renderBoardPage(n: BoardNumbers): string {
  const script = `<script>
(() => {
  const tiles = document.getElementById('tiles');
  const status = document.getElementById('status');
  async function refresh() {
    try {
      const res = await fetch('/board/tiles' + location.search, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      tiles.innerHTML = await res.text();
      status.textContent = '';
    } catch (e) {
      status.textContent = 'Reconnecting. These numbers are from the last good read.';
    }
  }
  setInterval(refresh, 5000);
})();
</script>`;
  return shell(`<main id="tiles">${renderTiles(n)}</main><p id="status" class="status" aria-live="polite"></p>${script}`);
}

export function renderClosedPage(status: number): string {
  const text = status === 503 ? 'The board is off.' : 'This board needs its full link.';
  return shell(`<main><header><div class="eyebrow">Go, live numbers</div><h1>${text}</h1></header></main>`);
}
```

```ts
// apps/brain/src/stats/routes.ts
/** The proof board's routes. Closed unless ADMIN_TOKEN is set; every read needs it as ?token=, the bench sends it as a bearer. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Brain } from '../app.js';
import { renderBoardPage, renderClosedPage, renderTiles } from './board-html.js';
import { statsRegistry } from './sources.js';
import { computeBoard, type BoardNumbers } from './stats.js';

export type StatsBrain = Pick<Brain, 'env' | 'pool' | 'http' | 'now' | 'log'>;

/** What a bench run sends to the board for one chat. */
export const BenchSummary = z.object({
  chat: z.string().regex(/^[a-z0-9-]{1,40}$/),
  mode: z.enum(['fast', 'live']),
  cacheHit: z.number().min(0).max(1).nullable(),
  cacheStatus: z.enum(['ok', 'not_cacheable_yet', 'no_requests']),
  wakeRate: z.number().min(0).max(1).nullable(),
  typingP90Ms: z.number().nonnegative().nullable(),
  replyP50Ms: z.number().nonnegative().nullable(),
  recall: z.object({ passed: z.int().nonnegative(), probes: z.int().nonnegative() }),
  wrongSpeak: z.int().nonnegative(),
  messages: z.int().nonnegative(),
  at: z.iso.datetime({ offset: true }),
});
export type BenchSummary = z.infer<typeof BenchSummary>;

type Query = { token?: string; hours?: string };
interface Denied { status: number; body: { error: { code: string; message: string } } }

function tokenOk(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given === '') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function hoursOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 168 ? n : 2;
}

export function registerStats(brain: StatsBrain): void {
  const { http, pool } = brain;
  const denied = (token: unknown): Denied | null => {
    const expected = brain.env.ADMIN_TOKEN;
    if (expected === undefined || expected === '') return { status: 503, body: { error: { code: 'unavailable', message: 'The board is off until ADMIN_TOKEN is set.' } } };
    if (!tokenOk(token, expected)) return { status: 401, body: { error: { code: 'bad_signature', message: 'Wrong or missing token.' } } };
    return null;
  };
  const board = (q: Query): Promise<BoardNumbers> => computeBoard(pool, statsRegistry(brain), { now: brain.now(), hours: hoursOf(q.hours) });
  const htmlHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' };

  http.get<{ Querystring: Query }>('/stats.json', async (req, reply) => {
    const no = denied(req.query.token);
    if (no !== null) return reply.code(no.status).send(no.body);
    return reply.header('cache-control', 'no-store').send(await board(req.query));
  });

  http.get<{ Querystring: Query }>('/board', async (req, reply) => {
    const no = denied(req.query.token);
    if (no !== null) return reply.code(no.status).headers(htmlHeaders).type('text/html; charset=utf-8').send(renderClosedPage(no.status));
    return reply.headers(htmlHeaders).type('text/html; charset=utf-8').send(renderBoardPage(await board(req.query)));
  });

  http.get<{ Querystring: Query }>('/board/tiles', async (req, reply) => {
    const no = denied(req.query.token);
    if (no !== null) return reply.code(no.status).send(no.body);
    return reply.headers(htmlHeaders).type('text/html; charset=utf-8').send(renderTiles(await board(req.query)));
  });

  http.post('/stats/bench', async (req, reply) => {
    const auth = req.headers.authorization;
    const no = denied(typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined);
    if (no !== null) return reply.code(no.status).send(no.body);
    const parsed = BenchSummary.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'invalid', message: z.prettifyError(parsed.error).slice(0, 500) } });
    const s = parsed.data;
    await pool.query(
      `insert into bench_reports (chat, mode, summary, received_at) values ($1, $2, $3, $4)
       on conflict (chat) do update set mode = excluded.mode, summary = excluded.summary, received_at = excluded.received_at`,
      [s.chat, s.mode, JSON.stringify(s), brain.now()],
    );
    return reply.code(204).send();
  });
}
```

```ts
// apps/brain/src/stats/index.ts
export { BenchSummary, registerStats, type StatsBrain } from './routes.js';
export { StatsRegistry, statsRegistry, type StatsSource, type StatsWindow, type StatValue } from './sources.js';
export { computeBoard, type BoardNumbers } from './stats.js';
```

In `apps/brain/src/main.ts`, add the import next to the other lanes' imports:

```ts
import { registerStats } from './stats/index.js';
```

and add `registerStats` to the lane list `start()` runs, right after `registerMemory` (right after `registerReflex` while `registerMemory` is not in `main.ts` yet), written the same way as the lines around it, for example:

```ts
  await registerStats(brain);
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/stats/board-html.ts apps/brain/src/stats/routes.ts apps/brain/src/stats/index.ts apps/brain/src/stats/__tests__/routes.test.ts apps/brain/src/main.ts
git commit -m "feat(stats): the proof board page, its numbers as JSON, and a place for bench results

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `routes.test.ts` passes (7 tests); P1's boot tests still pass with `registerStats` in the lane list.

---

