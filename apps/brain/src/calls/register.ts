// Wires calls into Go: the call_business tool, the stop words, the Stop button, the "Go can phone" block,
// Twilio's status callback and the media socket, which P1's door hands over.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { Brain, RegisterLane } from '../app.js';
import type { NowProvider } from '../composer/context.js';
import { realSchedule, type Schedule } from '../proactive/clock.js';
import { attachBridge } from './bridge.js';
import { CALL_CAP_MS, REALTIME_VOICE, loadCallsConfig, statusUrl } from './config.js';
import { openVoice } from './realtime.js';
import { CallService } from './service.js';
import { CallStore } from './store.js';
import { callTool } from './tool.js';
import { twilioClient, verifyTwilioSignature } from './twilio.js';

export const CALLS_ORDER = 70;
export const MEDIA_PATH = /^\/calls\/media\/(call_[A-Za-z0-9_-]{1,58})$/;

export function callsNow(service: CallService): NowProvider {
  return {
    name: 'calls',
    order: CALLS_ORDER,
    async render(tripId: string): Promise<string | null> {
      if (service.mode() === 'off' || !service.ready()) return null;
      const lines: string[] = [];
      const names = service.callable();
      if (names.length > 0) lines.push(`Go can phone (call_business with the name): ${names.join(', ')}.`);
      const live = await service.liveFor(tripId);
      if (live?.state === 'waiting') lines.push(`Go said it will call ${live.business} and is waiting 30 seconds for anyone to say stop.`);
      else if (live) lines.push(`Go is on a call to ${live.business} now (${live.state}). The call card shows it live.`);
      const stopped = await service.recentlyCancelled(tripId);
      if (stopped) lines.push(`The call to ${stopped.business} was called off because someone said stop, and Go already replied. Say nothing more about it.`);
      return lines.length > 0 ? lines.join('\n') : null;
    },
  };
}

export interface CallsHandles {
  service: CallService;
  tick(): Promise<void>;
  /** Ends every live call, waits for each to close out, and takes no new media socket. */
  stop(): Promise<void>;
}

export interface StartCallsOpts {
  /** Tests pass false and drive the tick by hand. */
  intervals?: boolean;
  fetch?: typeof fetch;
  openVoice?: () => WebSocket;
  schedule?: Schedule;
}

export async function startCalls(brain: Brain, o: StartCallsOpts = {}): Promise<CallsHandles> {
  // Twilio's media socket reaches Go only through the door (master §6.3: Door.onUpgrade). Without it every call
  // would ring and then sit in silence, so refuse to start, loudly, before anything is registered.
  if (typeof brain.door.onUpgrade !== 'function') {
    const why = 'calls: the door has no onUpgrade (master §6.3), so Twilio media cannot reach Go; calls not started';
    brain.log.error(why);
    throw new Error(why);
  }
  const config = loadCallsConfig(brain.env);
  const schedule = o.schedule ?? realSchedule;
  const twilio = config.accountSid && config.authToken
    ? twilioClient({ accountSid: config.accountSid, authToken: config.authToken, ...(o.fetch ? { fetch: o.fetch } : {}) })
    : null;
  const service = new CallService({
    store: new CallStore(brain.pool),
    link: brain.door.link,
    packs: brain.packs,
    switches: brain.switches,
    config,
    twilio,
    now: brain.now,
    schedule,
    log: brain.log,
  });

  // The tool is offered only when a call can really go out: every setting set and at least one named business, with
  // the CALLS_MODE switch on (it flips at runtime, so it is read every turn). Prod, 10 Oct: with calls unset the tool was
  // still offered, its "a cab about a pickup" had Go offer to call a local cab operator, and "yes call" placed nothing.
  const ready = service.ready();
  if (ready) brain.tools.register({ ...callTool(service), offered: () => service.mode() === 'allowlist' });
  brain.hooks.onRead((msg, _read, pack) => service.onMessage(msg, pack));
  brain.taps.on('call', 'stop', (tap) => service.stopTap(tap));
  brain.context.addNow(callsNow(service));

  await brain.http.register(async (scope) => {
    if (!scope.hasContentTypeParser('application/x-www-form-urlencoded')) {
      scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      });
    }
    scope.post<{ Params: { callId: string }; Body: Record<string, string> }>('/calls/twilio/status/:callId', async (req, reply) => {
      const params = req.body ?? {};
      const signed = config.publicUrl !== null
        && verifyTwilioSignature(config.authToken, statusUrl(config.publicUrl, req.params.callId), params, req.headers['x-twilio-signature']);
      if (!signed) return reply.code(403).send({ error: { code: 'bad_signature', message: 'not signed by Twilio' } });
      await service.onTwilioStatus(req.params.callId, params.CallStatus ?? '');
      return reply.code(204).send();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const openModel = o.openVoice ?? (() => openVoice({ model: config.voiceModel, apiKey: config.openaiKey ?? '' }));
  let stopped = false;
  // Each live call's "closed out" promise, so stopping Go can wait for them.
  const bridges = new Set<Promise<void>>();
  const onMedia = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const callId = MEDIA_PATH.exec((req.url ?? '').split('?')[0] ?? '')?.[1];
    if (stopped || !callId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const { closed } = attachBridge(ws, callId, {
        claim: (id, token) => service.claim(id, token),
        openVoice: openModel,
        hangUp: (id) => service.hangUp(id),
        hooks: {
          talking: (id) => service.talking(id),
          line: (id, line) => service.line(id, line),
          outcome: (id, oc) => service.outcome(id, oc),
          ended: (id, reason) => service.ended(id, reason),
        },
        schedule,
        capMs: CALL_CAP_MS,
        session: { model: config.voiceModel, voice: REALTIME_VOICE },
        log: brain.log,
      });
      bridges.add(closed);
      void closed.finally(() => bridges.delete(closed));
    });
  };
  brain.door.onUpgrade(MEDIA_PATH, onMedia);

  const handles: NodeJS.Timeout[] = [];
  if (o.intervals !== false) {
    const h = setInterval(() => {
      service.tick().catch((err: unknown) => brain.log.warn({ err }, 'calls: tick failed'));
    }, 1000);
    h.unref();
    handles.push(h);
  }
  brain.log.info(
    { voiceModel: config.voiceModel, missing: config.missing, named: service.callable().length },
    ready ? 'calls: ready' : 'calls: not set up yet; call_business is not offered',
  );

  const stop = async (): Promise<void> => {
    stopped = true;
    for (const h of handles.splice(0)) clearInterval(h);
    // A live call's media socket goes now; each call closes out (final card, the line in the room) before Go stops.
    for (const ws of wss.clients) ws.terminate();
    await Promise.allSettled([...bridges]);
    wss.close();
  };
  // When Go stops (master §6.3: Brain.onStop), the tick stops, live calls end, and no new media socket is taken.
  brain.onStop(stop);

  return { service, tick: () => service.tick(), stop };
}

export const registerCalls: RegisterLane = async (brain) => {
  await startCalls(brain);
};
