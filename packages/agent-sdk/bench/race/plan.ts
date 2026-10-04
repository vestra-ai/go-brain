/**
 * The race's running order: every task, on every engine, `runs` times, in an order drawn
 * from a seed. Each run shuffles the tasks, and each task flips which engine goes first, so
 * neither engine always meets a warm box, a warm provider cache or a quiet hour first. The
 * seed is in the plan, so a run can be repeated exactly.
 *
 * The plan is plain JSON: the staging box driver (apps/server/scripts/drills/race-box.mjs)
 * reads it and never imports this package, and writes one run record per slot back.
 */
import { localizeForSlot, type RaceCategory, type RaceTask } from './tasks.js';

export const RACE_PLAN_SCHEMA = 'vestra.race-plan/v1';
export const RACE_ENGINES = ['native', 'claude_code'] as const;
export type RaceEngine = (typeof RACE_ENGINES)[number];
/** The one model both engines race on (brief B8c). */
export const RACE_MODEL = 'claude-sonnet-5-5';

export interface RaceSlot {
  /** 1-based position in the running order. */
  slot: number;
  task: string;
  category: RaceCategory;
  engine: RaceEngine;
  /** 1-based repeat number. */
  run: number;
  turns: readonly string[];
  needs: ReadonlyArray<'web' | 'mock-travel-mcp'>;
  measureTurn: number;
}

export interface RacePlan {
  schema: typeof RACE_PLAN_SCHEMA;
  model: string;
  seed: number;
  runs: number;
  engines: RaceEngine[];
  slots: RaceSlot[];
}

/** mulberry32: a small seeded generator, so the order is reproducible from the seed alone. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. */
export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface PlanOptions {
  tasks: readonly RaceTask[];
  engines?: readonly RaceEngine[];
  runs?: number;
  seed?: number;
  model?: string;
}

export function buildPlan(opts: PlanOptions): RacePlan {
  const engines = [...(opts.engines ?? RACE_ENGINES)];
  const runs = opts.runs ?? 2;
  const seed = opts.seed ?? 1;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`race plan: runs must be a whole number of at least 1, got ${String(opts.runs)}`);
  if (engines.length === 0) throw new Error('race plan: no engines');
  if (opts.tasks.length === 0) throw new Error('race plan: no tasks');
  const rand = seededRandom(seed);
  const slots: RaceSlot[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const task of shuffle(opts.tasks, rand)) {
      for (const engine of shuffle(engines, rand)) {
        const slot = slots.length + 1;
        slots.push({
          slot,
          task: task.id,
          category: task.category,
          engine,
          run,
          turns: task.turns.map((t) => localizeForSlot(t, slot)),
          needs: task.needs ?? [],
          measureTurn: task.measureTurn ?? 0,
        });
      }
    }
  }
  return { schema: RACE_PLAN_SCHEMA, model: opts.model ?? RACE_MODEL, seed, runs, engines, slots };
}
