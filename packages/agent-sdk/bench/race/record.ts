/**
 * What one slot of the race produced, as the staging box driver writes it
 * (apps/server/scripts/drills/race-box.mjs). Timings are measured where a person sees them:
 * on the socket the web app listens to, from the moment the message is sent. Tokens and the
 * model-call count come from the server's own rows for the task (agent_turns, AGENT_RESULT),
 * never from the model's words.
 */
import { priceUsageUsd } from '../../src/contract/usage-pricing.js';
import type { RaceEngine } from './plan.js';

export const RACE_RUNS_SCHEMA = 'vestra.race-runs/v1';

export interface RaceToolCall {
  name: string;
  /** The input, as JSON, cut to 6,000 characters (a written file's content is the evidence). */
  input: string;
  /** The result's text, cut to 1,500 characters. */
  result: string;
  isError: boolean;
}

export interface RaceTurnRecord {
  index: number;
  /**
   * ms from the send to the first text the person can read: streamed text, or a tool card that
   * carries a narration line (native writes one on every tool card). Thinking does not count.
   */
  firstVisibleMs: number | null;
  /** ms from the send to the first streamed text alone. */
  firstTextMs: number | null;
  /** ms from the send to the first tool call on the stream. */
  firstToolMs: number | null;
  /** ms from the send to the turn's end; null when it never ended within the timeout. */
  totalMs: number | null;
  /** The turn's outcome kind (completed, error, timeout, paused, ...). */
  outcome: string;
  /** The final reply: the completed outcome's summary, else the streamed text. */
  reply: string;
  tools: RaceToolCall[];
  /** Model calls the engine made this turn (AGENT_RESULT numTurns), when it said. */
  modelCalls: number | null;
}

export interface RaceTokens {
  /** Uncached input. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface RaceRunRecord {
  slot: number;
  task: string;
  category: string;
  engine: RaceEngine;
  run: number;
  /** The model the plan asked for. */
  model: string;
  /** The model the provider said answered (agent_turns.model_responded). */
  modelResponded: string | null;
  /** The engine the task was locked to (tasks.runtime). */
  ranOn: string | null;
  taskId: string;
  turns: RaceTurnRecord[];
  tokens: RaceTokens;
  /** Native only: what our ledger recorded for the task, before margin (credit_ledger). */
  ledgerUsd: number | null;
  /** A slot that could not run (a missing precondition), with the reason. Not a failure. */
  skipped?: string;
  error?: string;
}

export interface RaceRunsFile {
  schema: typeof RACE_RUNS_SCHEMA;
  model: string;
  seed: number;
  startedAt: string;
  /** Where it ran, for the report's header (e.g. "staging, drill account"). Never an email. */
  where: string;
  runs: RaceRunRecord[];
}

/**
 * The tokens priced at list for the model (the shared pricer, the same one billing uses).
 * The Claude Code engine runs on the person's plan, so this is what the same work would cost
 * on the API, not what anyone paid. Null when the model has no price row.
 */
export function listPriceUsd(model: string, t: RaceTokens): number | null {
  const priced = priceUsageUsd(model, {
    inputTokens: t.input,
    outputTokens: t.output,
    cacheReadTokens: t.cachedInput,
    cacheWriteTokens: t.cacheWrite,
  });
  return priced ? Math.round(priced.usd * 1e6) / 1e6 : null;
}
