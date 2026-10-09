/**
 * The trip's computer on Vestra /v1, for its jobs: one user per trip (created with the admin key, its default deployment
 * go-trip-task), one conversation per job, and the trip token armed before every job. The box is woken by a job itself,
 * never at setup. The browser the trip reads ixigo.com in is the person's own (browsers.ts), never this one.
 * A job's own conversation is idle on /v1 exactly when nothing of the job is left to run: its start and every
 * follow-up settled, and no work open. Each step is safe to repeat; what is done is recorded in trip_computers.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Setup } from '../trips/setup.js';
import type { TokenStore } from '../mcp/tokens.js';
import type { TasksRuntime } from './env.js';
import type { V1Client } from './v1-client.js';

export const TRIP_TOKEN_SECRET = 'TRIP_TOKEN';

export interface Computer {
  userIdFor(tripId: string): string;
  ensureUser(tripId: string): Promise<string>;
  /** The job's own conversation on the trip user: the same one however often it is asked for. */
  conversation(tripId: string, taskId: string): Promise<{ userId: string; conversationId: string }>;
  /** A fresh token in the trip user's TRIP_TOKEN secret, good until `expiresAt`, checked against Go's MCP server. */
  armToken(tripId: string, expiresAt: Date): Promise<void>;
  releaseTokens(tripId: string): Promise<void>;
  /** The trips that still hold a live token. */
  tripsWithTokens(): Promise<string[]>;
}

export interface ComputerDeps {
  pool: pg.Pool;
  v1: V1Client;
  tokens: TokenStore;
  env: Pick<TasksRuntime, 'VESTRA_DEPLOYMENT_ID' | 'VESTRA_MCP_SERVER_ID'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

/** /v1 user ids allow letters, digits and ._:@- only, so the trip id is hashed. */
export function v1UserIdFor(tripId: string): string {
  return `gotrip-${createHash('sha256').update(tripId).digest('hex').slice(0, 32)}`;
}

export function createComputer(d: ComputerDeps): Computer {
  async function row(tripId: string): Promise<{ v1_user_id: string; user_ready_at: Date | null } | null> {
    const { rows } = await d.pool.query<{ v1_user_id: string; user_ready_at: Date | null }>(
      'select v1_user_id, user_ready_at from trip_computers where trip_id = $1',
      [tripId],
    );
    return rows[0] ?? null;
  }

  const putSecret = (userId: string, value: string) => d.v1.call('PUT', `/v1/secrets/${TRIP_TOKEN_SECRET}`, { body: { user_id: userId, value } });

  async function reachesGo(userId: string): Promise<boolean> {
    if (!d.env.VESTRA_MCP_SERVER_ID) return true;
    try {
      const r = await d.v1.call<{ ok: boolean }>('POST', `/v1/mcp-servers/${d.env.VESTRA_MCP_SERVER_ID}/check`, { body: { user_id: userId } });
      return r.ok === true;
    } catch {
      return false;
    }
  }

  const computer: Computer = {
    userIdFor: v1UserIdFor,

    async ensureUser(tripId) {
      const known = await row(tripId);
      if (known?.user_ready_at) return known.v1_user_id;
      const userId = v1UserIdFor(tripId);
      await d.pool.query('insert into trip_computers (trip_id, v1_user_id) values ($1, $2) on conflict (trip_id) do nothing', [tripId, userId]);
      await d.v1.call('POST', '/v1/users', {
        admin: true,
        idempotencyKey: `go-user-${userId}`,
        body: { user_id: userId, name: `Go trip ${tripId}`.slice(0, 200), timezone: 'Asia/Kolkata', metadata: { go_trip_id: tripId } },
      });
      // A repeat POST ignores the profile, so the deployment is set with PATCH every time this runs.
      await d.v1.call('PATCH', `/v1/users/${userId}`, { admin: true, body: { default_deployment: d.env.VESTRA_DEPLOYMENT_ID } });
      await d.pool.query('update trip_computers set user_ready_at = $2 where trip_id = $1', [tripId, d.now()]);
      return userId;
    },

    async conversation(tripId, taskId) {
      const userId = await computer.ensureUser(tripId);
      // The job's id is the idempotency key, so a hand-off that runs again gets the same conversation back.
      const c = await d.v1.call<{ id: string }>('POST', '/v1/conversations', {
        idempotencyKey: `go-conv-${taskId}`,
        body: { user_id: userId, deployment: d.env.VESTRA_DEPLOYMENT_ID, metadata: { go_trip_id: tripId, go_task_id: taskId } },
      });
      return { userId, conversationId: c.id };
    },

    async armToken(tripId, expiresAt) {
      const userId = await computer.ensureUser(tripId);
      const token = await d.tokens.mint(tripId, expiresAt);
      await putSecret(userId, token);
      if (await reachesGo(userId)) return;
      await putSecret(userId, token);
      if (!(await reachesGo(userId))) {
        d.log.warn({ tripId }, "tasks: the trip's computer cannot reach Go's MCP server with its token; the job runs on its context alone");
      }
    },

    async releaseTokens(tripId) {
      await d.tokens.revokeAll(tripId);
    },

    tripsWithTokens: () => d.tokens.liveTrips(),
  };
  return computer;
}

/**
 * Setup's step for the trip's computer: its /v1 user; level-triggered, so the setup sweep finishes what stopped halfway.
 * A new trip's box is not woken: it wakes for the trip's first job.
 */
export function addComputerSteps(setup: Pick<Setup, 'addStep'>, computer: Computer): void {
  setup.addStep({ name: 'computer.user', run: async (tripId) => { await computer.ensureUser(tripId); } });
}
