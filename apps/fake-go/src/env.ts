// The fake Go's settings. Secrets come only from Railway's variables, never from the repo.
import { z } from 'zod';

export const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  GO_SIGNING_SECRET: z.string().min(32, 'GO_SIGNING_SECRET must be at least 32 characters: make it with openssl rand -hex 32'),
  FAKE_GO_ADMIN_TOKEN: z.string().min(16, 'FAKE_GO_ADMIN_TOKEN must be at least 16 characters'),
  /** The fake Go's own base URL, for the links it hands out. Railway's domain is used when this is not set. */
  FAKE_GO_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Set by Railway, e.g. fake-go-production.up.railway.app. */
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),
});
export type Env = z.infer<typeof Env>;

export function publicUrl(env: Env): string {
  if (env.FAKE_GO_PUBLIC_URL) return env.FAKE_GO_PUBLIC_URL.replace(/\/+$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${env.PORT}`;
}
