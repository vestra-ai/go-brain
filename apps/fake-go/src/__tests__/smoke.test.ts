import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeGoBehaviour } from '../behaviour.js';
import { buildFakeGo, type FakeGo } from '../server.js';
import { runSmoke } from '../smoke.js';

const secret = 'fake-go-test-secret-0123456789abcdef';
let fake: FakeGo | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function start(): Promise<string> {
  fake = buildFakeGo({ secret, adminToken: 'admin-token-for-tests-0001', behaviour: (link) => fakeGoBehaviour(link, { publicUrl: 'https://fake-go.test' }) });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(fake.app.server.address() as AddressInfo).port}`;
}

describe('the smoke check', () => {
  it('passes against a running fake Go, and prints every frame both ways', async () => {
    const goUrl = await start();
    const lines: string[] = [];
    const report = await runSmoke({ goUrl, secret, print: (l) => lines.push(l), timeoutMs: 5000 });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.goRequests).toEqual(['typing on', 'read_trip', 'add_reaction', 'post_message', 'typing off']);
    expect(lines.some((l) => l.startsWith('health: 200'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Server -> Go') && l.includes('trip.created'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Go -> Server') && l.includes('post_message'))).toBe(true);
  });

  it('fails with a plain reason when the secret is wrong', async () => {
    const goUrl = await start();
    const report = await runSmoke({ goUrl, secret: 'not-the-secret-not-the-secret-000', print: () => {}, timeoutMs: 1500 });
    expect(report.ok).toBe(false);
    expect(report.problems).toContain('the socket did not open: check GO_URL and GO_SIGNING_SECRET');
  });
});
