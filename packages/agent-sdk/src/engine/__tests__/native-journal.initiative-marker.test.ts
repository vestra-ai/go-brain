/**
 * P4 Task 4 — the initiative turn's durable marker. On an `initiative` origin the
 * driver appends ONE `custom {key:'initiative', data:{trigger,politeness}}` entry
 * alongside the turn's user entry, so a fresh-process resume can re-derive "this turn
 * is ambient" from the journal (P2 durability). It rides the existing `custom` payload
 * kind (CONTEXT_POLICY:false — state, never replayed into the model), the
 * instruction-snapshot precedent. A human/absent origin appends NOTHING → byte-identical.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, MessageOrigin } from '../../contract/harness.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { appendUserEntry, appendInitiativeMarker } from '../native-journal.js';

const dir = join(tmpdir(), `native-journal-initiative-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const file = (taskId: string) => join(dir, `${taskId}.jsonl`);
const make = (taskId = 't') => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(file(taskId)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});
const ctxFor = (taskId = 't', userId = 'u'): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId } } } as unknown as HarnessContext<NativeConfigLike>);

const INITIATIVE: MessageOrigin = {
  kind: 'initiative',
  trigger: { kind: 'scheduled', scheduleId: 'r1', firedAt: '2026-01-01T00:00:00.000Z' },
  politeness: 'silent-unless-actionable',
};

describe('appendInitiativeMarker', () => {
  it('appends a custom initiative entry for an initiative origin', async () => {
    const j = make('t-init');
    const ctx = ctxFor('t-init');
    await appendUserEntry(j, ctx, 'go');
    await appendInitiativeMarker(j, ctx, INITIATIVE);

    const raw = await fs.readFile(file('t-init'), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    const marker = lines.find((e) => e.payload?.type === 'custom' && e.payload?.key === 'initiative');
    expect(marker).toBeDefined();
    expect(marker.payload.data).toEqual({
      trigger: { kind: 'scheduled', scheduleId: 'r1', firedAt: '2026-01-01T00:00:00.000Z' },
      politeness: 'silent-unless-actionable',
    });
  });

  it('appends NOTHING for a human origin (byte-identical)', async () => {
    const j = make('t-human');
    const ctx = ctxFor('t-human');
    await appendUserEntry(j, ctx, 'go');
    await appendInitiativeMarker(j, ctx, { kind: 'human' });

    const raw = await fs.readFile(file('t-human'), 'utf8');
    expect(raw).not.toContain('"key":"initiative"');
    expect(raw.trim().split('\n')).toHaveLength(1); // only the user entry
  });

  it('appends NOTHING when origin is absent', async () => {
    const j = make('t-none');
    const ctx = ctxFor('t-none');
    await appendUserEntry(j, ctx, 'go');
    await appendInitiativeMarker(j, ctx, undefined);

    const raw = await fs.readFile(file('t-none'), 'utf8');
    expect(raw).not.toContain('"key":"initiative"');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });
});
