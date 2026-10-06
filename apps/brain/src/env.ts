import { z } from 'zod';
import { AdminEnv } from './admin/env.js';
import { CallsEnv } from './calls/env.js';
import { MemoryEnv } from './memory/env.js';
import { MoneyEnv } from './money/env.js';
import { ProactiveEnv } from './proactive/env.js';
import { ReflexEnv } from './reflex/env.js';
import { StatsEnv } from './stats/env.js';
import { TasksEnv } from './tasks/env.js';
import { TravelEnv } from './travel/env.js';
import { WatchesEnv } from './watches/env.js';

/** Lane A: the basics and the composer's models. */
export const RoomEnv = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  DATABASE_URL: z.string().min(1),
  /** Shared with the Server. Make one with: openssl rand -hex 32 */
  GO_SIGNING_SECRET: z.string().min(32),
  /** Go's own https address, for links to Go's pages. */
  GO_PUBLIC_URL: z.url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  COMPOSER_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  SIDE_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Every lane's own variables, in boot order. A lane edits only its own <folder>/env.ts, never this file. */
export const LANE_ENVS = {
  reflex: ReflexEnv,
  memory: MemoryEnv,
  stats: StatsEnv,
  travel: TravelEnv,
  tasks: TasksEnv,
  money: MoneyEnv,
  proactive: ProactiveEnv,
  watches: WatchesEnv,
  calls: CallsEnv,
  admin: AdminEnv,
} as const;

/** Every lane's variables, merged. zod drops keys no lane declares, so every lane's stub is merged here from day one. */
export const Env = z.object({
  ...RoomEnv.shape,
  ...ReflexEnv.shape,
  ...MemoryEnv.shape,
  ...StatsEnv.shape,
  ...TravelEnv.shape,
  ...TasksEnv.shape,
  ...MoneyEnv.shape,
  ...ProactiveEnv.shape,
  ...WatchesEnv.shape,
  ...CallsEnv.shape,
  ...AdminEnv.shape,
});
export type Env = z.infer<typeof Env>;

export function loadEnv(src: Record<string, string | undefined> = process.env): Env {
  const r = Env.safeParse(src);
  if (!r.success) throw new Error(`Bad environment:\n${z.prettifyError(r.error)}`);
  return r.data;
}
