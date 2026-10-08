// The admin page: the operator's desk at the side of the stage. Health, the demo switches, the simulated watch and two
// clean-up buttons, each through a lane's own interface. It does not exist unless ADMIN_TOKEN is set, and every route
// needs that token as a bearer, or the session cookie a person gets by opening /admin#token=... (session.ts). The token
// is never read from a URL.
import type * as C from '@go/contract';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Brain, RegisterLane } from '../app.js';
import { newUlid } from '../door/ulid.js';
import type { RecipeStat } from '../travel/book/engine.js';
import type { TripWatches } from '../travel/recipe-watches.js';
import { checkAll, checkComputer, defaultProbes, type Probe, type ProbeResult } from './health.js';
import { ADMIN_LANES, NOT_DEPLOYED, type AdminLanes } from './lanes.js';
import { renderAdminPage } from './page.js';
import { PAGE_HEADERS, registerSessionRoute, signedIn, signInPage, type SessionOptions } from './session.js';
import { SWITCH_RULES, type SwitchName } from './switches.js';

export const DOCS_URL = 'https://vestrago.vercel.app/docs';
export const SWITCH_NAMES = Object.keys(SWITCH_RULES) as SwitchName[];

const FORM = 'application/x-www-form-urlencoded';

/** Which deployment this Go is: brain (the stage), brain-rehearsal, or brain-try (where visitors chat with Go). null when it cannot tell. */
export type GoRole = 'stage' | 'rehearsal' | 'try';

/** GO_ROLE, else Railway's service name (brain is the stage, brain-rehearsal the rehearsal Go, brain-try the try-room Go), else null. */
export function roleOf(env: { GO_ROLE?: GoRole | undefined; RAILWAY_SERVICE_NAME?: string | undefined }): GoRole | null {
  if (env.GO_ROLE) return env.GO_ROLE;
  if (env.RAILWAY_SERVICE_NAME === 'brain-rehearsal') return 'rehearsal';
  if (env.RAILWAY_SERVICE_NAME === 'brain-try') return 'try';
  if (env.RAILWAY_SERVICE_NAME === 'brain') return 'stage';
  return null;
}

/** What GET /admin/health.json answers. The rehearsal runner reads it before it starts. */
export interface HealthJson {
  at: string;
  /** The rehearsal runner runs only on a Go that says it is the rehearsal Go. */
  role: GoRole | null;
  trip_id: string | null;
  server_socket_open: boolean;
  probes: ProbeResult[];
  switches: Record<SwitchName, string>;
  /** Names only: a phone number never leaves Go. */
  calls: { mode: string; allowlist: string[]; allowlist_count: number };
  /** How fast each ixigo recipe answers, at each speed, since Go started. */
  recipes: RecipeStat[];
  /** The watches groups asked for that are going: per trip, how many and when the next is checked. */
  watches: TripWatches[];
}

/** The "Fire a watch" form. The rest of P6's body is fixed for the demo. */
export const FireForm = z.object({
  trip_id: z.string().min(1).max(64),
  person_id: z.string().min(1).max(64),
  label: z.string().min(1).max(80).default('IndiGo 6E 2134'),
  delay_minutes: z.coerce.number().int().min(0).max(1440).default(120),
  note: z.string().min(1).max(200).optional(),
});
const TripForm = z.object({ trip_id: z.string().min(1).max(64) });

type Query = { trip?: string; note?: string };
type Req = FastifyRequest<{ Querystring: Query; Body: unknown }>;
/** The GET routes log at warn: a request line never lands in the logs at info, whatever its URL holds. */
const QUIET = { logLevel: 'warn' } as const;

/** The body as an object, with empty form fields left out (an empty field means "not given"). */
function filled(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  return Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([, v]) => !(typeof v === 'string' && v.trim() === '')));
}

const err = (code: string, message: string) => ({ error: { code, message } });

export interface AdminOptions {
  /** The checks to run; tests pass their own. Default: every dependency (health.ts). */
  probes?: (brain: Brain, tripId: string | null) => Probe[];
  fetch?: typeof fetch;
  /** The other lanes' helpers; tests pass their own. Default: the real ones (lanes.ts). */
  lanes?: AdminLanes;
}

export function registerAdminWith(o: AdminOptions = {}): RegisterLane {
  return async (brain) => {
    const token = brain.env.ADMIN_TOKEN;
    if (!token) {
      brain.log.info('admin: the page is off until ADMIN_TOKEN is set');
      return;
    }
    const lanes = o.lanes ?? ADMIN_LANES;
    const probesFor = o.probes ?? ((b: Brain, tripId: string | null) => defaultProbes(b, tripId, lanes, o.fetch ?? fetch));

    const newestTrips = async (): Promise<string[]> =>
      (await brain.pool.query<{ trip_id: string }>('select trip_id from trips order by active_at desc limit 10')).rows.map((r) => r.trip_id);
    const tripOf = async (q: Query): Promise<string | null> => {
      const asked = q.trip?.trim();
      return asked ? asked : ((await newestTrips())[0] ?? null);
    };
    const switchValues = (): Array<{ name: SwitchName; value: string }> => SWITCH_NAMES.map((name) => ({ name, value: brain.switches.get(name) }));
    const calls = () => {
      const c = lanes.calls;
      return {
        mode: brain.switches.get('CALLS_MODE'),
        deployed: c !== null,
        allowlist: c ? c.allowlist(brain.env).map((a) => ({ name: a.name, masked: c.maskPhone(a.phone) })) : [],
      };
    };
    const peopleOf = async (tripId: string | null): Promise<Array<{ id: string; name: string }>> => {
      // The pack is read from the Server; with no Server connected there is nothing to read, and the form takes an id.
      if (!tripId || !brain.door.link.isOpen()) return [];
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 1_000).unref();
      });
      const pack = await Promise.race([brain.packs.get(tripId).catch(() => null), timeout]);
      return pack ? pack.trip.people.map((p) => ({ id: p.person_id, name: p.name })) : [];
    };

    /** JSON gets JSON; the page's forms go back to the page with a note. */
    const answer = (req: Req, reply: FastifyReply, status: number, body: unknown, note: string, tripId: string | null) => {
      if (!String(req.headers['content-type'] ?? '').startsWith(FORM)) return reply.code(status).send(body);
      const q = new URLSearchParams({ ...(tripId ? { trip: tripId } : {}), note });
      return reply.code(303).header('location', `/admin?${q.toString()}`).send();
    };

    const session: SessionOptions = { token, secure: brain.env.GO_PUBLIC_URL.startsWith('https:'), now: brain.now };
    const role = roleOf(brain.env);
    registerSessionRoute(brain.http, session);
    await brain.http.register(async (scope) => {
      if (!scope.hasContentTypeParser(FORM)) {
        scope.addContentTypeParser(FORM, { parseAs: 'string' }, (_req, body, done) => {
          done(null, Object.fromEntries(new URLSearchParams(String(body))));
        });
      }
      scope.addHook('onRequest', async (req, reply) => {
        if (signedIn(req, session)) return;
        // Not signed in: the page itself answers with the sign-in page, which reads the token from after the #.
        if (req.method === 'GET' && req.routeOptions.url === '/admin') {
          return reply.headers(PAGE_HEADERS).type('text/html; charset=utf-8').send(signInPage('Go: stage desk', '/admin'));
        }
        return reply.code(401).send(err('bad_signature', 'Wrong or missing admin token.'));
      });

      scope.get<{ Querystring: Query }>('/admin', QUIET, async (req, reply) => {
        const tripId = await tripOf(req.query);
        const [health, people, trips] = await Promise.all([checkAll(probesFor(brain, tripId)), peopleOf(tripId), newestTrips()]);
        const html = renderAdminPage({
          tripId, trips, role, at: brain.now(), health, switches: switchValues(), people, calls: calls(), recipes: brain.recipeStats?.() ?? [],
          watches: (await brain.recipeWatches?.()) ?? [], note: req.query.note ?? null, docsUrl: DOCS_URL,
        });
        return reply.headers(PAGE_HEADERS).type('text/html; charset=utf-8').send(html);
      });

      scope.get<{ Querystring: Query }>('/admin/health.json', QUIET, async (req, reply) => {
        const tripId = await tripOf(req.query);
        const c = calls();
        const body: HealthJson = {
          at: brain.now().toISOString(),
          role,
          trip_id: tripId,
          server_socket_open: brain.door.link.isOpen(),
          probes: await checkAll(probesFor(brain, tripId)),
          switches: Object.fromEntries(switchValues().map((s) => [s.name, s.value])) as Record<SwitchName, string>,
          calls: { mode: c.mode, allowlist: c.allowlist.flatMap((a) => (a.name ? [a.name] : [])), allowlist_count: c.allowlist.length },
          recipes: brain.recipeStats?.() ?? [],
          watches: (await brain.recipeWatches?.()) ?? [],
        };
        return reply.header('cache-control', 'no-store').send(body);
      });

      scope.post<{ Querystring: Query; Body: unknown }>('/admin/switches', async (req, reply) => {
        const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
        const name = String(body['name'] ?? '');
        const value = String(body['value'] ?? '');
        const trip = req.query.trip ?? null;
        if (!Object.hasOwn(SWITCH_RULES, name)) return answer(req, reply, 422, err('invalid', `${name} is not a switch`), `${name} is not a switch`, trip);
        const sw = name as SwitchName;
        if (!SWITCH_RULES[sw].valid(value)) return answer(req, reply, 422, err('invalid', `${sw} cannot be "${value}"`), `${sw} cannot be "${value}"`, trip);
        await brain.switches.set(sw, value);
        brain.log.info({ name: sw, value }, 'admin: a switch changed');
        return answer(req, reply, 200, { ok: true, name: sw, value }, `${sw} is now ${value || 'none'}`, trip);
      });

      scope.post<{ Querystring: Query; Body: unknown }>('/admin/fire-watch', async (req, reply) => {
        const trip = req.query.trip ?? null;
        const parsed = FireForm.safeParse(filled(req.body));
        if (!parsed.success) return answer(req, reply, 422, err('invalid', z.prettifyError(parsed.error).slice(0, 300)), 'Pick the trip and the person first.', trip);
        const f = parsed.data;
        if (!brain.http.hasRoute({ method: 'POST', url: '/admin/watch/fire' })) {
          const message = `Watches are ${NOT_DEPLOYED}.`;
          return answer(req, reply, 404, err('not_found', message), message, f.trip_id);
        }
        // P6's route, in process, with the demo's body: the same bar as any watch, and its card says "Simulated for the demo".
        const res = await brain.http.inject({
          method: 'POST',
          url: '/admin/watch/fire',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          payload: {
            trip_id: f.trip_id, label: f.label, person_ids: [f.person_id], delay_minutes: f.delay_minutes,
            ...(f.note ? { note: f.note } : {}), importance: 1, urgency: 1, reset_budget: true, force: true,
          },
        });
        let out: unknown;
        try {
          out = res.json();
        } catch {
          out = err('unavailable', res.body.slice(0, 200));
        }
        const fired = (out ?? {}) as { promoted?: unknown; duplicate?: unknown };
        const note = res.statusCode !== 200
          ? `The watch did not fire (HTTP ${res.statusCode}).`
          : fired.duplicate === true ? 'That watch already fired a moment ago, so nothing new went out.'
          : fired.promoted === 1 ? 'The watch fired: one nudge is on its way.' : 'The watch fired, but the bar held it back.';
        return answer(req, reply, res.statusCode, out, note, f.trip_id);
      });

      scope.post<{ Querystring: Query; Body: unknown }>('/admin/stop-jobs', async (req, reply) => {
        const parsed = TripForm.safeParse(filled(req.body));
        if (!parsed.success) return answer(req, reply, 422, err('invalid', 'trip_id is required'), 'Pick a trip first.', req.query.trip ?? null);
        const tripId = parsed.data.trip_id;
        const tasks = brain.tasks;
        if (!tasks) {
          const message = `Jobs are ${NOT_DEPLOYED}.`;
          return answer(req, reply, 409, err('conflict', message), message, tripId);
        }
        const running = await tasks.running(tripId);
        // Every job gets its stop, even when an earlier one fails.
        const tried = await Promise.allSettled(running.map((t) => tasks.stop(t.id)));
        const ids = running.filter((_, k) => tried[k]?.status === 'fulfilled').map((t) => t.id);
        const failed = running.filter((_, k) => tried[k]?.status === 'rejected').map((t) => t.id);
        for (const r of tried) if (r.status === 'rejected') brain.log.warn({ err: r.reason, trip: tripId }, 'admin: a job did not stop');
        const plural = (n: number): string => `${n} running job${n === 1 ? '' : 's'}`;
        const note = running.length === 0 ? 'No job was running.'
          : failed.length === 0 ? `Stopped ${plural(ids.length)}.` : `Stopped ${plural(ids.length)}; ${failed.length} did not stop.`;
        return answer(req, reply, failed.length === 0 ? 200 : 502, { ok: failed.length === 0, stopped: ids, ...(failed.length ? { failed } : {}) }, note, tripId);
      });

      // The one place the admin wakes a trip's computer: on purpose, never from the health view.
      scope.post<{ Querystring: Query; Body: unknown }>('/admin/check-computer', async (req, reply) => {
        const parsed = TripForm.safeParse(filled(req.body));
        if (!parsed.success) return answer(req, reply, 422, err('invalid', 'trip_id is required'), 'Pick a trip first.', req.query.trip ?? null);
        const tripId = parsed.data.trip_id;
        if (!lanes.v1UserIdFor) {
          const message = `Trip computers are ${NOT_DEPLOYED}.`;
          return answer(req, reply, 404, err('not_found', message), message, tripId);
        }
        const checked = await checkComputer(brain.env, o.fetch ?? fetch, lanes.v1UserIdFor(tripId)).catch((e: unknown) => ({
          ok: false, detail: `The check failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
        }));
        return answer(req, reply, checked.ok ? 200 : 502, { ok: checked.ok, detail: checked.detail }, checked.detail, tripId);
      });

      scope.post<{ Querystring: Query; Body: unknown }>('/admin/decline-pay', async (req, reply) => {
        const parsed = TripForm.safeParse(filled(req.body));
        if (!parsed.success) return answer(req, reply, 422, err('invalid', 'trip_id is required'), 'Pick a trip first.', req.query.trip ?? null);
        const tripId = parsed.data.trip_id;
        const { rows } = await brain.pool.query<{ card: C.Card }>(
          `select card from cards where trip_id = $1 and kind = 'pay' and card->>'state' = 'waiting' order by updated_at desc limit 1`,
          [tripId],
        );
        const card = rows[0]?.card;
        if (!card || card.kind !== 'pay') return answer(req, reply, 404, err('not_found', 'No pay card is waiting in this trip.'), 'No pay card is waiting.', tripId);
        // The payer's own Decline, through P1's tap router: one answer per tap, and P5 releases the Server's approval.
        const result = await brain.taps.dispatch({
          tap_id: `tap_admin_${newUlid()}`, trip_id: tripId, card_id: card.card_id, action_id: 'decline', person_id: card.payer_person_id,
        });
        const ok = result.result !== 'refused';
        const why = 'toast' in result && result.toast ? result.toast : 'refused';
        return answer(req, reply, ok ? 200 : 409, { ok, card_id: card.card_id, answer: result }, ok ? 'The waiting pay card was declined.' : `Not declined: ${why}`, tripId);
      });
    });
  };
}

export const registerAdmin: RegisterLane = registerAdminWith();
