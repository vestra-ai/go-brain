import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TwilioError, streamTwiml, twilioClient, twilioOutcome, verifyTwilioSignature } from '../twilio.js';

function capture(status = 201, body: unknown = { sid: 'CA123', status: 'queued' }) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchFake };
}

describe('twilioClient', () => {
  it('places a call with TwiML, a signed status callback, a time limit and no recording', async () => {
    const { seen, fetchFake } = capture();
    const client = twilioClient({ accountSid: 'AC_test', authToken: 'tok_test', fetch: fetchFake });
    const twiml = streamTwiml({ url: 'wss://brain.test/calls/media/call_1', token: 'one-use' });
    expect(await client.createCall({ to: '+919800000001', from: '+14155550100', twiml, statusCallback: 'https://brain.test/calls/twilio/status/call_1', timeLimitS: 255, ringTimeoutS: 30 })).toEqual({ sid: 'CA123' });

    const [req] = seen;
    expect(req?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls.json');
    expect(req?.init.method).toBe('POST');
    const headers = req?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('AC_test:tok_test').toString('base64')}`);
    const form = new URLSearchParams(String(req?.init.body));
    expect(form.get('To')).toBe('+919800000001');
    expect(form.get('From')).toBe('+14155550100');
    expect(form.get('Twiml')).toBe(twiml);
    expect(form.get('StatusCallback')).toBe('https://brain.test/calls/twilio/status/call_1');
    expect(form.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    expect(form.get('TimeLimit')).toBe('255');
    expect(form.get('Timeout')).toBe('30');
    expect(form.get('Record')).toBe('false');
  });

  it('hangs up by setting the call completed', async () => {
    const { seen, fetchFake } = capture(200, { sid: 'CA123', status: 'completed' });
    await twilioClient({ accountSid: 'AC_test', authToken: 'tok_test', fetch: fetchFake }).hangUp('CA123');
    expect(seen[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls/CA123.json');
    expect(new URLSearchParams(String(seen[0]?.init.body)).get('Status')).toBe('completed');
  });

  it('turns a refusal into a TwilioError with Twilio code', async () => {
    const { fetchFake } = capture(400, { code: 21215, message: 'Account not authorized to call +919800000001.' });
    const err = await twilioClient({ accountSid: 'AC_test', authToken: 'tok_test', fetch: fetchFake })
      .createCall({ to: '+919800000001', from: '+14155550100', twiml: '<Response/>', statusCallback: 'https://brain.test/x', timeLimitS: 1, ringTimeoutS: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TwilioError);
    expect(err).toMatchObject({ status: 400, code: 21215 });
  });
});

describe('streamTwiml', () => {
  it('connects a stream and passes the token as a parameter, escaped', () => {
    const xml = streamTwiml({ url: 'wss://brain.test/calls/media/call_1', token: 'a"b<c>&d' });
    expect(xml).toContain('<Connect><Stream url="wss://brain.test/calls/media/call_1">');
    expect(xml).toContain('<Parameter name="token" value="a&quot;b&lt;c&gt;&amp;d"/>');
    expect(xml).not.toContain('?token=');
  });
});

describe('verifyTwilioSignature', () => {
  const url = 'https://brain.test/calls/twilio/status/call_1';
  const params = { CallSid: 'CA123', CallStatus: 'completed', AccountSid: 'AC_test', CallDuration: '41' };
  const sign = (token: string, u: string, p: Record<string, string>): string =>
    createHmac('sha1', token).update(Object.keys(p).sort().reduce((acc, k) => acc + k + p[k], u)).digest('base64');

  it('accepts a request Twilio signed for this exact URL', () => {
    expect(verifyTwilioSignature('tok_test', url, params, sign('tok_test', url, params))).toBe(true);
    expect(verifyTwilioSignature('tok_test', url, params, [sign('tok_test', url, params)])).toBe(true);
  });

  it('refuses a changed parameter, another URL, a missing header or no token', () => {
    const good = sign('tok_test', url, params);
    expect(verifyTwilioSignature('tok_test', url, { ...params, CallStatus: 'busy' }, good)).toBe(false);
    expect(verifyTwilioSignature('tok_test', 'http://brain.test/calls/twilio/status/call_1', params, good)).toBe(false);
    expect(verifyTwilioSignature('tok_test', url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(null, url, params, good)).toBe(false);
  });
});

describe('twilioOutcome', () => {
  it('maps Twilio call statuses', () => {
    expect(twilioOutcome('ringing')).toBe('ringing');
    expect(twilioOutcome('in-progress')).toBe('answered');
    expect(twilioOutcome('completed')).toBe('completed');
    expect(twilioOutcome('busy')).toBe('busy');
    expect(twilioOutcome('no-answer')).toBe('no_answer');
    expect(twilioOutcome('failed')).toBe('failed');
    expect(twilioOutcome('canceled')).toBe('canceled');
    expect(twilioOutcome('something-new')).toBe('other');
  });
});
