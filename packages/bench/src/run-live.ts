/**
 * The live bench: by hand or nightly, never on a push. The same replay with the real composer
 * models and real Jev. It reports the provider's own cache numbers, first-word and reply times,
 * cost per trip, and a model table, so COMPOSER_MODEL is picked by measurement.
 *   node packages/bench/dist/run-live.js --chats goa-50,goa-300 --models claude-sonnet-5-5,claude-haiku-4-5 [--gate-model m] [--record-jev] [--post-board]
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { recordingFor, writeRecording } from './bench-reflex.js';
import { loadChat } from './chat.js';
import { compareLive, loadBars, pickModel, type LiveRun } from './compare.js';
import { recordingClient, type ClientLike } from './recorder.js';
import { replayChat, SimClock } from './replay.js';
import { writeReport, type BenchReport } from './report-md.js';
import { RequestLog } from './requests.js';
import { commitSha, OUT_DIR } from './run-fast.js';
import { providerNumbers, scoreReplay, wrongSpeak } from './score.js';

type EnvSource = Readonly<Record<string, string | undefined>>;

export interface LiveArgs { chats: string[]; models: string[]; gateModel: string; recordJev: boolean; postBoard: boolean }

export function parseArgs(argv: readonly string[]): LiveArgs {
  const value = (flag: string): string | undefined => {
    const k = argv.indexOf(flag);
    const v = k >= 0 ? argv[k + 1] : undefined;
    return v === undefined || v.startsWith('--') ? undefined : v;
  };
  const list = (v: string | undefined, fallback: string[]): string[] => {
    const xs = (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    return xs.length > 0 ? xs : fallback;
  };
  const models = list(value('--models'), ['claude-sonnet-5-5', 'claude-haiku-4-5']);
  return {
    chats: list(value('--chats'), ['goa-50', 'goa-300']),
    models,
    gateModel: value('--gate-model') ?? models[0] ?? 'claude-sonnet-5-5',
    recordJev: argv.includes('--record-jev'),
    postBoard: argv.includes('--post-board'),
  };
}

/** Go's environment for one live run: the real keys, a fresh local signing secret and board token. */
export function liveEnv(env: EnvSource, model: string): Record<string, string> {
  const need = (k: string): string => {
    const v = env[k];
    if (v === undefined || v === '') throw new Error(`${k} is required for the live bench`);
    return v;
  };
  const baseUrl = env['TYPESAFE_BASE_URL'];
  const reflexLive = env['REFLEX_LIVE'];
  return {
    DATABASE_URL: need('DATABASE_URL'),
    ANTHROPIC_API_KEY: need('ANTHROPIC_API_KEY'),
    TYPESAFE_API_KEY: need('TYPESAFE_API_KEY'),
    ...(baseUrl !== undefined && baseUrl !== '' ? { TYPESAFE_BASE_URL: baseUrl } : {}),
    JEV_MODEL: env['JEV_MODEL'] || 'jev-1.13.0',
    // Unless the run names one, Go's own default applies: the questions whose test sets passed (reflex/live-gate.ts).
    ...(reflexLive !== undefined && reflexLive !== '' ? { REFLEX_LIVE: reflexLive } : {}),
    COMPOSER_MODEL: model,
    SIDE_MODEL: env['SIDE_MODEL'] || 'claude-haiku-4-5',
    // No GO_SIGNING_SECRET: P1's startRoom signs the socket with its own SECRET.
    GO_PUBLIC_URL: 'http://127.0.0.1',
    CALLS_MODE: 'off',
    LOG_LEVEL: 'warn',
    ADMIN_TOKEN: randomBytes(16).toString('hex'),
  };
}

/** What the board's POST /stats/bench takes (Task 9's BenchSummary). */
export interface BoardSummary {
  chat: string;
  mode: 'live';
  cacheHit: number | null;
  cacheStatus: 'ok' | 'not_cacheable_yet' | 'no_requests';
  wakeRate: number | null;
  typingP90Ms: number | null;
  replyP50Ms: number | null;
  recall: { passed: number; probes: number };
  wrongSpeak: number;
  messages: number;
  at: string;
  /** The commit and branch this run came from, and the composer model it judged (the board keeps it, never shows it). */
  commit: string | null;
  branch: string | null;
  model: string;
}

export function toBoardSummary(run: LiveRun, at: string, from: { commit: string | null; branch: string | null }): BoardSummary {
  const s = run.score;
  const hit = run.provider.cacheHit ?? s.cache.hitRate;
  return {
    chat: run.chat,
    mode: 'live',
    cacheHit: hit === null ? null : Math.min(1, Math.max(0, hit)),
    cacheStatus: s.cache.status,
    wakeRate: s.wake.rate,
    typingP90Ms: s.typing.p90Ms,
    replyP50Ms: s.reply.p50Ms,
    recall: { passed: s.recall.passed, probes: s.recall.probes },
    wrongSpeak: wrongSpeak(s),
    messages: s.messages.people,
    at,
    commit: from.commit,
    branch: from.branch,
    model: run.model,
  };
}

export async function postSummary(url: string, token: string, summary: BoardSummary, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/stats/bench`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(summary),
  });
  if (!res.ok) throw new Error(`the board refused the bench summary for ${summary.chat}: HTTP ${res.status}`);
}

export async function runLive(args: LiveArgs, env: EnvSource): Promise<BenchReport> {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey === '') throw new Error('ANTHROPIC_API_KEY is required for the live bench');
  const runs: LiveRun[] = [];
  for (const model of args.models) {
    for (const name of args.chats) {
      const chat = loadChat(name);
      const clock = new SimClock();
      const log = new RequestLog(model);
      const real = new Anthropic({ apiKey, maxRetries: 0 }) as unknown as ClientLike;
      const out = await replayChat({
        chat, mode: 'live', rawEnv: liveEnv(env, model), client: recordingClient(real, log, clock.now), log, clock,
        reflex: { kind: 'live' }, settings: { quietTimeoutMs: 120_000 }, progress: (line) => console.log(line),
      });
      const run: LiveRun = {
        model, chat: name, score: scoreReplay(out.record), provider: providerNumbers(out.record.requests), ...(out.jev !== null ? { jev: out.jev } : {}),
      };
      runs.push(run);
      console.log(`${model} on ${name}: reply p50 ${run.score.reply.p50Ms ?? 'n/a'} ms, provider cache ${run.provider.cacheHit ?? 'n/a'}`);
      if (model === args.gateModel && args.recordJev && out.recorded !== null) {
        writeRecording(name, recordingFor(chat, out.recorded, env['JEV_MODEL'] || 'jev-1.13.0', new Date().toISOString()));
      }
      const boardUrl = env['GO_BOARD_URL'];
      const boardToken = env['GO_BOARD_TOKEN'];
      if (model === args.gateModel && args.postBoard && boardUrl && boardToken) {
        const from = { commit: commitSha(), branch: env['GITHUB_REF_NAME'] || null };
        await postSummary(boardUrl, boardToken, toBoardSummary(run, new Date().toISOString(), from));
      }
    }
  }
  const v = compareLive(runs, loadBars().live, args.gateModel);
  return {
    schema: 'go.bench-report/v1', mode: 'live', at: new Date().toISOString(), commit: commitSha(),
    scores: runs.map((r) => r.score), live: runs, pick: pickModel(runs, v.byModel), verdict: { ok: v.ok, checks: v.checks },
  };
}

async function main(): Promise<void> {
  const report = await runLive(parseArgs(process.argv.slice(2)), process.env);
  writeReport(report, OUT_DIR, 'live-report');
  console.log(report.pick ? `Suggested COMPOSER_MODEL: ${report.pick.model}. It ${report.pick.why}.` : 'No model to suggest.');
  process.exitCode = report.verdict.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
