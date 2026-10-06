import { z } from 'zod';

/**
 * Lane C (P4): Vestra /v1. P4 took this file over from P1's stub; P1's env.ts already merges this object's shape, so it
 * is never edited for a new variable. Every value is optional (jobs stay off until all are set), and each one is also
 * in apps/brain/.env.example.
 */
export const TasksEnv = z.object({
  VESTRA_API_URL: z.url().optional(),
  /** Comma-separated keys with the runtime and setup scopes (or all), all of one mode. Requests and streams spread across them. */
  VESTRA_API_KEYS: z.string().min(1).optional(),
  VESTRA_WEBHOOK_SECRET: z.string().min(1).optional(),
  VESTRA_DEPLOYMENT_ID: z.string().min(1).optional(),
  /** A key with the admin scope, of the same mode: only for creating and changing the trip users. */
  VESTRA_ADMIN_KEY: z.string().min(1).optional(),
  /** Go's MCP server as /v1 knows it (mcp_...), printed by scripts/setup-v1.ts. Used to check a trip's token reaches Go. */
  VESTRA_MCP_SERVER_ID: z.string().min(1).optional(),
});

const KEY = /^vk_(live|test)_[A-Za-z0-9_-]{43}$/;
const commaList = (item: z.ZodString) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0))
    .pipe(z.array(item).min(1));

const TasksRuntime = z.object({
  GO_PUBLIC_URL: z.url(),
  VESTRA_API_URL: z.url(),
  VESTRA_API_KEYS: commaList(z.string().regex(KEY)),
  VESTRA_ADMIN_KEY: z.string().regex(KEY),
  VESTRA_WEBHOOK_SECRET: commaList(z.string().min(16)),
  VESTRA_DEPLOYMENT_ID: z.string().min(3),
  VESTRA_MCP_SERVER_ID: z.string().min(3).optional(),
});
export type TasksRuntime = z.infer<typeof TasksRuntime>;

/** What jobs need from the merged env, or null while anything is missing. */
export function readTasksEnv(env: unknown): TasksRuntime | null {
  const r = TasksRuntime.safeParse(env);
  return r.success ? r.data : null;
}
