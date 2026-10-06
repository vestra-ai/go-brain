/**
 * The fast bench: every push, no keys. Replays each chat through Go with the scripted policy
 * model and the bench reflex, scores it, and judges it against bars.json.
 *   DATABASE_URL=... pnpm --filter @go/bench bench:fast [goa-50 goa-300 goa-2000]
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadRecording } from './bench-reflex.js';
import { loadChat } from './chat.js';
import { compareFast, loadBars } from './compare.js';
import { PolicyModel } from './policy-model.js';
import { replayChat, SimClock, type ReplaySettings } from './replay.js';
import { writeReport, type BenchReport } from './report-md.js';
import { scoreReplay, type ChatScore } from './score.js';

/**
 * Go's environment in the fast bench, laid over startRoom's test values. No real key anywhere: the model and the
 * reflex are stand-ins, and Jev is off. No GO_SIGNING_SECRET: the harness signs the socket with its own.
 */
export const FAST_ENV: Readonly<Record<string, string>> = {
  GO_PUBLIC_URL: 'http://127.0.0.1',
  ANTHROPIC_API_KEY: 'bench-no-key',
  COMPOSER_MODEL: 'claude-sonnet-5-5',
  SIDE_MODEL: 'claude-haiku-4-5',
  REFLEX_LIVE: 'off',
  CALLS_MODE: 'off',
  LOG_LEVEL: 'silent',
  ADMIN_TOKEN: 'bench-admin-token-local',
};

export interface FastChat { name: string; env?: Record<string, string>; settings?: Partial<ReplaySettings>; timeoutMs: number }

export const FAST_CHATS: readonly FastChat[] = [
  { name: 'goa-50', timeoutMs: 300_000 },
  { name: 'goa-300', timeoutMs: 600_000 },
  // A small fold budget so a week of chat folds at least once (P2's FOLD_AT_TOKENS).
  { name: 'goa-2000', env: { FOLD_AT_TOKENS: '12000' }, settings: { settleMs: 40 }, timeoutMs: 1_500_000 },
];

export const OUT_DIR = new URL('../out/', import.meta.url);

export async function runFastChat(c: FastChat, databaseUrl: string): Promise<{ score: ChatScore; board: unknown }> {
  const chat = loadChat(c.name);
  const recorded = loadRecording(c.name);
  const clock = new SimClock();
  const policy = new PolicyModel({ composerModel: FAST_ENV['COMPOSER_MODEL'] ?? 'claude-sonnet-5-5', simNow: clock.now });
  const out = await replayChat({
    chat,
    mode: 'fast',
    rawEnv: { ...FAST_ENV, ...(c.env ?? {}), DATABASE_URL: databaseUrl },
    client: policy.client,
    log: policy.log,
    clock,
    reflex: { kind: 'bench', recorded },
    ...(c.settings !== undefined ? { settings: c.settings } : {}),
    progress: (line) => console.log(line),
  });
  return { score: scoreReplay(out.record), board: out.board };
}

export function commitSha(): string | null {
  const sha = process.env['GITHUB_SHA'];
  if (sha !== undefined && sha !== '') return sha.slice(0, 10);
  try {
    return execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function fastReport(scores: ChatScore[], boards: Record<string, unknown>): BenchReport {
  return { schema: 'go.bench-report/v1', mode: 'fast', at: new Date().toISOString(), commit: commitSha(), scores, boards, verdict: compareFast(scores, loadBars().fast) };
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required');
  const names = process.argv.slice(2);
  const chats = names.length > 0 ? FAST_CHATS.filter((c) => names.includes(c.name)) : FAST_CHATS;
  const scores: ChatScore[] = [];
  const boards: Record<string, unknown> = {};
  for (const c of chats) {
    const r = await runFastChat(c, databaseUrl);
    scores.push(r.score);
    boards[c.name] = r.board;
  }
  const report = fastReport(scores, boards);
  writeReport(report, OUT_DIR, 'bench-report');
  console.log(report.verdict.ok ? 'All bars pass.' : `${report.verdict.checks.filter((c) => !c.ok).length} checks fail; see out/bench-report.md`);
  process.exitCode = report.verdict.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
