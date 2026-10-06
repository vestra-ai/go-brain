/**
 * POST /v1-webhooks: Vestra's signed events. The signature is checked over the raw body bytes (HMAC-SHA256 of
 * "<t>.<raw body>", at most 300 s old, against the current secret or the one being rolled). Each evt_ id is applied
 * once; when applying fails the answer is 500 and the id is forgotten, so Vestra's retry is applied.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { EventStore } from './event-store.js';
import type { TaskEvents, V1Event } from './events.js';

export type SignatureCheck = 'ok' | 'missing' | 'malformed' | 'stale' | 'mismatch';

export function verifyV1Signature(raw: string, header: string | undefined, secrets: string[], nowSec: number, toleranceSec = 300): SignatureCheck {
  if (!header) return 'missing';
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const k = part.slice(0, at).trim();
    const v = part.slice(at + 1).trim();
    if (k === 't') t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (t === null || !Number.isInteger(t) || signatures.length === 0) return 'malformed';
  if (Math.abs(nowSec - t) > toleranceSec) return 'stale';
  for (const secret of secrets) {
    const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest();
    if (signatures.some((s) => {
      const got = Buffer.from(s, 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    })) return 'ok';
  }
  return 'mismatch';
}

export interface PlatformEvent {
  id: string;
  type: string;
  created_at?: string;
  user_id?: string | null;
  task_id?: string | null;
  conversation_id?: string | null;
  data?: Record<string, unknown>;
}

/** A webhook or polled event as apply() takes it; the envelope's task_id fills in when the data has none. */
export function toV1Event(e: PlatformEvent, source: V1Event['source']): V1Event {
  const data: Record<string, unknown> = { ...(e.data ?? {}) };
  if (e.task_id && data.task_id === undefined) data.task_id = e.task_id;
  return { type: e.type, data, conversationId: e.conversation_id ?? null, source };
}

export interface WebhookDeps {
  secrets: string[];
  events: Pick<EventStore, 'markSeen' | 'unmarkSeen'>;
  apply: TaskEvents['apply'];
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export async function registerV1Webhooks(app: FastifyInstance, d: WebhookDeps): Promise<void> {
  await app.register(async (scope) => {
    // The raw bytes, never re-serialised JSON: the signature is over exactly what Vestra sent.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    scope.post('/v1-webhooks', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const header = req.headers['vestra-signature'];
      const check = verifyV1Signature(raw, typeof header === 'string' ? header : undefined, d.secrets, Math.floor(d.now().getTime() / 1000));
      if (check !== 'ok') {
        d.log.warn({ check }, 'tasks: a webhook failed its signature check');
        return reply.code(401).send({ error: 'bad_signature' });
      }
      let evt: PlatformEvent;
      try {
        evt = JSON.parse(raw) as PlatformEvent;
      } catch {
        return reply.code(400).send({ error: 'bad_body' });
      }
      if (typeof evt.id !== 'string' || typeof evt.type !== 'string') return reply.code(400).send({ error: 'bad_body' });
      if (!(await d.events.markSeen(evt.id, evt.type))) return reply.code(200).send({ ok: true, duplicate: true });
      try {
        await d.apply(toV1Event(evt, 'webhook'));
      } catch (err) {
        await d.events.unmarkSeen(evt.id);
        d.log.warn({ err, evt: evt.id }, 'tasks: applying a webhook failed; Vestra sends it again');
        return reply.code(500).send({ error: 'retry' });
      }
      return reply.code(200).send({ ok: true });
    });
  });
}
