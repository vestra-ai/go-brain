/**
 * Phase 3 (spec 2026-09-05-orchestration-teamwork §4.8, D10) — the turn-head note.
 *
 * The engine asks `cfg.turnHeadNote()` once per ingested user turn and appends what it
 * gets as its OWN injected user entry, right after the person's. What this file pins is
 * the shape of that append, because two properties are load-bearing and neither is
 * visible from the text:
 *
 *   · `injected: 'engine'` — the field every turn-counting rail reads. Without it the
 *     compaction keep-window, the elision floor and `splitTurn` treat the note as the
 *     latest ask and size themselves from a line the person never wrote.
 *   · A SEPARATE entry, never a prefix on the person's text — the loop must not put
 *     words inside a person's message (R6), and the injection screen keys on the same
 *     boundary.
 *
 * The journal-less path is pinned too: it is the only arm a host without a journal has,
 * and it takes a different code path (`transport.pushUser`).
 */
import { describe, it, expect } from 'vitest';
import { HookDispatcher } from '../../kernel/index.js';
import { ingestUserTurn, type RunTurnDeps } from '../native-run-turn.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { journalToOpenAIResponsesInput } from '../../transports/openai-responses-messages.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { RunPrologue } from '../native-run-open.js';
import type { RunContext } from '../run-context.js';
import type { Transport, ProviderHistory } from '../transport.js';
import type { ImageBlock, MediaBlock } from '../../contract/blocks.js';

type Appended = { text: string; injected?: string };

/** A journal that records only what this pin asks about: the user entries and their field. */
function fakeJournal(): { entries: Appended[]; journal: NativeConfig['journal'] } {
  const entries: Appended[] = [];
  const journal = {
    append: async (e: { payload: Record<string, unknown> }): Promise<void> => {
      const p = e.payload as {
        type: string;
        blocks?: Array<{ type: string; text?: string }>;
        injected?: string;
      };
      if (p.type !== 'user') return;
      const text = (p.blocks ?? []).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');
      entries.push(p.injected === undefined ? { text } : { text, injected: p.injected });
    },
  };
  return { entries, journal: journal as unknown as NativeConfig['journal'] };
}

/** A transport that records only `pushUser` — the journal-less arm's whole surface here. */
function fakeTransport(): { pushed: string[]; transport: Transport } {
  const pushed: string[] = [];
  const transport = {
    pushUser: (_h: ProviderHistory, text: string): void => {
      pushed.push(text);
    },
  };
  return { pushed, transport: transport as unknown as Transport };
}

function fakeCtx(cfg: NativeConfig): HarnessContext<NativeConfig> {
  return {
    taskId: 'task-1',
    sessionId: 'task-1',
    cwd: '/w',
    model: 'test-model',
    signal: new AbortController().signal,
    config: cfg,
  } as unknown as HarnessContext<NativeConfig>;
}

const deps = {
  terminalTurnEnd: () => {
    throw new Error('terminalTurnEnd must not fire on a clean ingest');
  },
  compactionDeps: () => {
    throw new Error('compactionDeps must not fire on a clean ingest');
  },
  runSignal: () => new AbortController().signal,
} as unknown as RunTurnDeps;

/** Drive one ingest to completion; it yields nothing on the clean path. */
async function ingest(
  cfg: NativeConfig,
  transport: Transport,
  text = 'what is happening?',
): Promise<void> {
  const gen = ingestUserTurn(
    fakeCtx(cfg),
    cfg,
    transport,
    { dispatcher: new HookDispatcher() } as unknown as RunPrologue,
    {} as unknown as RunContext,
    { text } as UserTurn,
    [] as unknown as ProviderHistory,
    [] as string[],
    [] as ImageBlock[],
    [] as MediaBlock[],
    () => ({ turnDeltaUsd: 0, parentOwnCostUsd: 0, childUsage: [] }),
    deps,
  );
  for await (const _ of gen) {
    /* the clean path yields nothing */
  }
}

describe('the turn-head note, on the journal', () => {
  it('appends the note as its OWN entry right after the person, stamped engine', async () => {
    const { entries, journal } = fakeJournal();
    const { transport } = fakeTransport();
    const note = '<helpers>@a working 2m</helpers>';
    await ingest({ journal, turnHeadNote: async () => note } as unknown as NativeConfig, transport);

    expect(entries).toEqual([
      { text: 'what is happening?' },
      { text: note, injected: 'engine' },
    ]);
  });

  it('never touches the person\'s own entry', async () => {
    // R6 — the note is a second entry, never a prefix folded into what the person typed.
    // Prepending it would hand the injection screen the loop's words as the user's ask.
    const { entries, journal } = fakeJournal();
    const { transport } = fakeTransport();
    await ingest(
      { journal, turnHeadNote: async () => '<helpers>@a working 2m</helpers>' } as unknown as NativeConfig,
      transport,
      'send the draft',
    );
    expect(entries[0]).toEqual({ text: 'send the draft' });
  });

  it('appends nothing when the seam answers null', async () => {
    const { entries, journal } = fakeJournal();
    const { transport } = fakeTransport();
    await ingest({ journal, turnHeadNote: async () => null } as unknown as NativeConfig, transport);
    expect(entries).toEqual([{ text: 'what is happening?' }]);
  });

  it('appends nothing when no seam is wired — the flag-off shape', async () => {
    const { entries, journal } = fakeJournal();
    const { transport } = fakeTransport();
    await ingest({ journal } as unknown as NativeConfig, transport);
    expect(entries).toEqual([{ text: 'what is happening?' }]);
  });

  it('asks the seam exactly once per turn', async () => {
    let calls = 0;
    const { journal } = fakeJournal();
    const { transport } = fakeTransport();
    await ingest(
      {
        journal,
        turnHeadNote: async () => {
          calls += 1;
          return '<helpers>@a working 2m</helpers>';
        },
      } as unknown as NativeConfig,
      transport,
    );
    expect(calls).toBe(1);
  });
});

describe('the turn-head note, with no journal', () => {
  it('pushes it behind the person, the way the wrap-up nudge does', async () => {
    const { pushed, transport } = fakeTransport();
    const note = '<helpers>@a waiting on the person</helpers>';
    await ingest({ turnHeadNote: async () => note } as unknown as NativeConfig, transport);
    expect(pushed).toEqual(['what is happening?', note]);
  });

  it('pushes only the person when the seam answers null', async () => {
    const { pushed, transport } = fakeTransport();
    await ingest({ turnHeadNote: async () => null } as unknown as NativeConfig, transport);
    expect(pushed).toEqual(['what is happening?']);
  });
});

describe('a CONTINUE turn', () => {
  it('carries no note, because it appends no user entry at all', async () => {
    // The HITL continue resolves a paused tool_use in place: skipping `appendUserEntry`
    // IS the auto-query suppression, and a note appended there would be a user entry the
    // continue was built not to have.
    const { entries, journal } = fakeJournal();
    const { transport } = fakeTransport();
    const cfg = {
      journal,
      turnHeadNote: async () => '<helpers>@a working 2m</helpers>',
    } as unknown as NativeConfig;
    const gen = ingestUserTurn(
      fakeCtx(cfg),
      cfg,
      transport,
      { dispatcher: new HookDispatcher() } as unknown as RunPrologue,
      {} as unknown as RunContext,
      { text: '', continueInteraction: true } as UserTurn,
      [] as unknown as ProviderHistory,
      [] as string[],
      [] as ImageBlock[],
      [] as MediaBlock[],
      () => ({ turnDeltaUsd: 0, parentOwnCostUsd: 0, childUsage: [] }),
      deps,
    );
    for await (const _ of gen) {
      /* nothing */
    }
    expect(entries).toEqual([]);
  });
});

/**
 * R6 — the note lands as a SECOND user-role entry directly behind the person's, so the
 * question the ruling asks is whether the wire can carry two user messages in a row.
 * It can, and not by luck: both projections end in the shared validity floor, whose
 * `mergeConsecutiveUserTurns` exists because Anthropic 400s on consecutive same-role
 * messages. That is what makes the journal path safe and why the note is never folded
 * into the person's text. Pinned here rather than assumed, because the day that merge
 * is narrowed is the day every roster line becomes a 400.
 */
describe('the wire shape behind the note (R6)', () => {
  const userEntry = (text: string, injected?: 'engine'): JournalEntry =>
    ({
      payload: {
        type: 'user',
        blocks: [{ type: 'text', text }],
        ...(injected ? { injected } : {}),
      },
    }) as unknown as JournalEntry;

  const note = '<helpers>@a working 2m</helpers>';

  it('Anthropic: the person and the note become ONE user message', () => {
    const wire = journalToAnthropicMessages([userEntry('what is happening?'), userEntry(note, 'engine')]);
    expect(wire).toHaveLength(1);
    expect(wire[0].role).toBe('user');
    expect(JSON.stringify(wire[0].content)).toContain(note);
    expect(JSON.stringify(wire[0].content)).toContain('what is happening?');
  });

  it('Anthropic: no two user messages ever land back to back', () => {
    const wire = journalToAnthropicMessages([
      userEntry('what is happening?'),
      userEntry(note, 'engine'),
      { payload: { type: 'assistant', blocks: [{ type: 'text', text: 'ok' }] } } as unknown as JournalEntry,
      userEntry('and the draft?'),
      userEntry(note, 'engine'),
    ]);
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('OpenAI Responses: both survive, in order, on a list that needs no alternation', () => {
    const wire = journalToOpenAIResponsesInput([
      userEntry('what is happening?'),
      userEntry(note, 'engine'),
    ]) as Array<{ role?: string; content?: unknown }>;
    expect(wire.map((i) => i.role)).toEqual(['user', 'user']);
    expect(wire[1].content).toBe(note);
  });
});
