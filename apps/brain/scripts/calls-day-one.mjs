#!/usr/bin/env node
// Day-one check for Go's phone calls. It never places a call. Run it from apps/brain with the brain
// service's environment, giving the teammate's number that will play the villa:
//   railway run --service brain node scripts/calls-day-one.mjs +919800000001
// It checks the Twilio account and caller number, that India is open for outbound calls, that a trial
// account has the number verified, the allowlist and the switch, that Go's media socket is reachable
// from outside, and that both voice models accept a mu-law session with no input transcription (the one
// CALLS_VOICE_MODEL picks must pass; the other is the day-one A/B and only warns). Exit code 1 if anything fails.
import WebSocket from 'ws';

// Keep these the same as apps/brain/src/calls/config.ts.
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const LIVE_URL = 'wss://api.openai.com/v1/live';
const REALTIME_MODEL = 'gpt-realtime-2.1';
const LIVE_MODEL = 'gpt-live-1';
const VOICE = 'marin';

const env = process.env;
const target = (process.argv[2] ?? '').replace(/[\s\-().]/g, '');
const chosen = env.CALLS_VOICE_MODEL?.trim() || REALTIME_MODEL;
const results = [];
const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail, fix) => results.push({ ok: false, name, detail, fix });
/** Only for the A/B: reported, never fails the run. */
const warn = (name, detail, fix) => results.push({ ok: true, warn: true, name, detail, fix });

async function twilioGet(url) {
  const auth = `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
  const res = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function checkTwilio() {
  const sid = env.TWILIO_ACCOUNT_SID;
  if (!sid || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
    fail('Twilio settings', 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_FROM is missing', 'Set all three on the brain service in Railway.');
    return;
  }
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const account = await twilioGet(`${base}.json`);
  if (account.status !== 200) {
    fail('Twilio account', `HTTP ${account.status}`, 'Check the account SID and auth token.');
    return;
  }
  const trial = account.body.type === 'Trial';
  pass('Twilio account', `${account.body.friendly_name} (${account.body.type}, ${account.body.status})`);

  const numbers = await twilioGet(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(env.TWILIO_FROM)}`);
  const number = numbers.body.incoming_phone_numbers?.[0];
  if (!number) fail('Caller number', `${env.TWILIO_FROM} is not a number on this account`, 'Buy a voice number, or set TWILIO_FROM to one this account owns.');
  else if (!number.capabilities?.voice) fail('Caller number', `${env.TWILIO_FROM} cannot make voice calls`, 'Pick a number with voice capability.');
  else pass('Caller number', `${env.TWILIO_FROM} can make voice calls`);

  const geo = await twilioGet('https://voice.twilio.com/v1/DialingPermissions/Countries/IN');
  if (geo.status !== 200) fail('India dialing', `could not read the geo permission (HTTP ${geo.status})`, 'Check Console > Voice > Settings > Geo permissions > India by hand.');
  else if (!geo.body.low_risk_numbers_enabled) fail('India dialing', 'India is not enabled for outbound calls', 'Enable India in Console > Voice > Settings > Geo permissions.');
  else pass('India dialing', 'enabled');

  if (trial && target) {
    const ids = await twilioGet(`${base}/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(target)}`);
    if ((ids.body.outgoing_caller_ids ?? []).length === 0) {
      fail('Trial account', `${target} is not verified`, "A trial account calls only verified numbers: verify the teammate's phone in the Console, or upgrade the account.");
    } else pass('Trial account', `${target} is verified`);
  }
}

function checkSettings() {
  const entries = (env.CALLS_ALLOWLIST ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  const numbers = entries.map((e) => e.slice(e.lastIndexOf('=') + 1).replace(/[\s\-().]/g, ''));
  if (entries.length === 0) fail('Allowlist', 'CALLS_ALLOWLIST is empty', 'Set it, e.g. "Villa Sol=+919800000001".');
  else if (target && !numbers.includes(target)) fail('Allowlist', `${target} is not on CALLS_ALLOWLIST`, 'Add it as "Villa Sol=<number>".');
  else pass('Allowlist', `${entries.length} entries`);
  if ((env.CALLS_MODE ?? 'off') !== 'allowlist') fail('CALLS_MODE', `is "${env.CALLS_MODE ?? 'off'}" in the environment`, 'Set CALLS_MODE=allowlist, or flip the switch on the admin page.');
  else pass('CALLS_MODE', 'allowlist');
  if (!env.OPENAI_API_KEY) fail('OPENAI_API_KEY', 'missing', 'Set it on the brain service in Railway.');
  if (!/^gpt-(realtime|live)/.test(chosen) || /transcri/i.test(chosen)) {
    fail('CALLS_VOICE_MODEL', `is "${chosen}"`, 'Leave it unset (gpt-realtime-2.1) or set gpt-live-1 for the A/B. Never a transcription model.');
  } else pass('CALLS_VOICE_MODEL', env.CALLS_VOICE_MODEL ? chosen : `${chosen} (unset, the default)`);
}

function checkMediaSocket() {
  return new Promise((resolve) => {
    if (!env.GO_PUBLIC_URL?.startsWith('https://')) {
      fail('Media socket', 'GO_PUBLIC_URL is not an https URL', "Set GO_PUBLIC_URL to the brain service's public https URL.");
      resolve();
      return;
    }
    const url = `wss://${new URL(env.GO_PUBLIC_URL).host}/calls/media/call_dayone_check`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      fail('Media socket', 'no answer in 10 s', 'Check the brain service is up and reachable.');
      ws.terminate();
      resolve();
    }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ event: 'start', streamSid: 'MZ_check', start: { streamSid: 'MZ_check', customParameters: { token: 'not-a-real-token' } } })));
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (code === 1008) pass('Media socket', 'reachable, and a wrong token is refused');
      else fail('Media socket', `closed with ${code}`, 'Expected 1008 for a wrong token.');
      resolve();
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      fail('Media socket', `upgrade answered HTTP ${res.statusCode}`, "The door refuses the media path: check that registerCalls ran (it registers through Door.onUpgrade, master §6.3) and the service logged no 'calls: the door has no onUpgrade' error.");
      resolve();
    });
    ws.on('error', () => undefined);
  });
}

/** Opens one voice model the way the bridge does (Task 11), with no input transcription, and reads its answer.
 *  The model CALLS_VOICE_MODEL picks must pass; the other one is the day-one A/B and only warns. */
function checkVoice(model, required) {
  const name = `Voice model ${model}${required ? '' : ' (A/B)'}`;
  const bad = (detail, fix) => (required ? fail : warn)(name, detail, fix);
  const live = model.startsWith('gpt-live');
  return new Promise((resolve) => {
    if (!env.OPENAI_API_KEY) {
      resolve();
      return;
    }
    const headers = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
    const ws = live ? new WebSocket(LIVE_URL, { headers }) : new WebSocket(`${REALTIME_URL}?model=${model}`, { headers });
    const done = () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    };
    const timer = setTimeout(() => {
      bad('no session in 10 s', 'Check the key and the network.');
      done();
    }, 10_000);
    ws.on('open', () =>
      ws.send(JSON.stringify(live
        ? {
            type: 'session.start',
            session: {
              model, instructions: 'Day-one check. Say nothing.', delegation: { type: 'client' }, store: false,
              audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: VOICE } },
            },
          }
        : {
            type: 'session.update',
            session: {
              type: 'realtime', model, output_modalities: ['audio'],
              audio: {
                input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
                output: { format: { type: 'audio/pcmu' }, voice: VOICE },
              },
            },
          })),
    );
    ws.on('message', (data) => {
      const ev = JSON.parse(String(data));
      if (!live && ev.type === 'session.updated') {
        const out = ev.session?.audio?.output?.format?.type;
        if (ev.session?.audio?.input?.transcription) {
          bad('input transcription is on', "By design, Go hears the call only through the voice model: the session must carry no audio.input.transcription.");
        } else if (out !== 'audio/pcmu') {
          bad(`session output format is ${out}`, 'The model did not take audio/pcmu: check the model id and the realtime docs.');
        } else pass(name, 'mu-law in and out, no input transcription');
        done();
      } else if (live && ev.type === 'session.started') {
        const format = ev.session?.audio?.format?.type;
        if (format && format !== 'audio/pcmu') bad(`session audio format is ${format}`, 'Live did not take audio/pcmu over this socket: keep gpt-realtime-2.1.');
        else pass(name, `a Live session started over ${LIVE_URL}${format ? ', mu-law' : ''}`);
        done();
      } else if (ev.type === 'error') {
        bad(ev.error?.message ?? 'error', live
          ? 'Check LIVE_URL and the session.start shape against the SDK (openai 7.15, resources/live/ws); fix them in calls/config.ts and calls/voice-wire.ts.'
          : `Check that ${model} exists for this key; change REALTIME_MODEL in calls/config.ts if not.`);
        done();
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      bad(`HTTP ${res.statusCode}`, live ? `Check LIVE_URL (${LIVE_URL}): Bash runs Live over WebRTC, so this socket address is unproven.` : 'Check the key and the model id.');
      done();
    });
    ws.on('error', () => undefined);
  });
}

await checkTwilio();
checkSettings();
await checkMediaSocket();
await checkVoice(chosen, true);
await checkVoice(chosen.startsWith('gpt-live') ? REALTIME_MODEL : LIVE_MODEL, false);

for (const r of results) {
  const word = r.warn ? 'WARN' : r.ok ? 'PASS' : 'FAIL';
  console.log(`${word}  ${r.name}: ${r.detail}${r.ok && !r.warn ? '' : `\n      fix: ${r.fix}`}`);
}
const twilioIndiaFailed = results.some((r) => !r.ok && (r.name === 'India dialing' || r.name === 'Caller number' || r.name === 'Twilio account'));
if (twilioIndiaFailed) {
  console.log('\nIf Twilio cannot call Indian numbers from this account, the fallback order is:');
  console.log('  1. Exotel or Plivo India (an Indian caller id; a second TwilioClient-shaped client in calls/, the bridge stays).');
  console.log("  2. OpenAI's own phone line (SIP), if the org has it: the call is accepted on OpenAI's side and Go drives it from a sideband socket.");
  console.log('  3. Vapi (about an hour to set up), driven by its API.');
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
