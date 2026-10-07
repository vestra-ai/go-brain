import type { DeskItem, DeskKind } from '../desk/desk.js';
import type { Log } from '../log.js';
import type { TripPack } from '../trips/pack.js';
import { chatLine, dataBlock, defuse, oneLine, personName } from './fence.js';
import { GO_RULES } from './rules.js';

export interface NowProvider {
  /** 'record', 'people', 'tasks', 'payments', 'openings'; P1 adds 'trip'. */
  name: string;
  /** A fixed order keeps the prompt stable. */
  order: number;
  /** Under 1,500 tokens; null when there is nothing to say. */
  render(tripId: string, wake: DeskItem[]): Promise<string | null>;
}

/** What P2's fold hands the prompt each turn. */
export interface StoryView {
  /** "The story so far", or null while the trip has not been folded. */
  story: string | null;
  /** The chat starts at this change number. */
  chatFromSeq: number;
  foldedToSeq: number;
  tokens: number;
}
export interface StoryProvider {
  get(tripId: string): Promise<StoryView>;
}

/** A turn's limits: the only tools it may call (stay_silent always works) and whether its text may be posted. */
export interface TurnLimits {
  tools: string[];
  mayPostText: boolean;
}

export interface Context {
  addNow(p: NowProvider): void;
  /** How a desk item of this kind reads in "why Go woke". P1 renders 'message', 'trip_change' and 'setup'; each lane renders its own kinds.
   *  Several lanes may render one kind (P4, P5 and P6 all render 'tap'): renderers run in registration order and the first
   *  non-null string wins; P1's generic line is the fallback. */
  addWake(kind: DeskKind, render: (item: DeskItem, pack: TripPack) => string | null): void;
  /** A line said once under "why Go woke", from all the wake items together (P1's note for messages that don't name Go). */
  addWakeNote(render: (items: DeskItem[], pack: TripPack) => string | null): void;
  /** P2's fold: the story block sits right before the chat chunks (inside the data fence), and the chat starts at chatFromSeq. */
  setStory(p: StoryProvider): void;
  /** P6's proactive bar: limits for a turn Go woke for on its own; null means no limits. */
  addTurnRules(fn: (wake: DeskItem[]) => TurnLimits | null): void;
}

/** A text block as the Messages API takes it. */
export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
}

export interface BuildInput {
  tripId: string;
  pack: TripPack;
  wake: DeskItem[];
  /** The newest message number the composer has already seen. */
  seenSeq: number;
  now: Date;
  tz: string;
}

export interface BuiltPrompt {
  /** Go's rules, cached for an hour. */
  system: TextBlock[];
  /** The first user message: the chat in blocks of 25 lines, then right now, then new since. */
  user: TextBlock[];
  /** The newest message number in this prompt; the turn stores it as seen. */
  newestSeq: number;
  chatLines: number;
}

export type ContextImpl = Context & {
  build(i: BuildInput): Promise<BuiltPrompt>;
  renderWake(item: DeskItem, pack: TripPack): string;
  /** The first rule's answer for these wake items, or null for no limits. */
  turnRules(wake: DeskItem[]): TurnLimits | null;
};

export const CHUNK = 25;
export const NEW_MAX = 25;
const HOUR = { type: 'ephemeral', ttl: '1h' } as const;

export function formatTime(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    // With the year: a model that has to guess it dates a trip in the past.
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now);
}

export function createContext(log: Log): ContextImpl {
  const providers: NowProvider[] = [];
  const wakes = new Map<DeskKind, Array<(item: DeskItem, pack: TripPack) => string | null>>();
  const rules: Array<(wake: DeskItem[]) => TurnLimits | null> = [];
  const notes: Array<(items: DeskItem[], pack: TripPack) => string | null> = [];
  let story: StoryProvider | null = null;

  function renderWake(item: DeskItem, pack: TripPack): string {
    for (const r of wakes.get(item.kind) ?? []) {
      try {
        const text = r(item, pack);
        if (text !== null) return text;
      } catch (e) {
        log.warn({ err: e, kind: item.kind }, 'a wake renderer failed');
      }
    }
    return `${item.kind} (${item.ref})`;
  }

  /** The fold's view of this trip; a broken fold is logged and the turn reads the whole chat. */
  async function storyOf(tripId: string): Promise<StoryView | null> {
    if (!story) return null;
    try {
      return await story.get(tripId);
    } catch (e) {
      log.warn({ err: e, trip: tripId }, 'the story so far failed; the turn reads the whole chat');
      return null;
    }
  }

  return {
    addNow(p) {
      if (providers.some((x) => x.name === p.name)) throw new Error(`a "${p.name}" block is already added`);
      providers.push(p);
      providers.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    },
    addWake(kind, render) {
      wakes.set(kind, [...(wakes.get(kind) ?? []), render]);
    },
    addWakeNote(render) {
      notes.push(render);
    },
    setStory(p) {
      if (story) throw new Error('the story so far is already set');
      story = p;
    },
    addTurnRules(fn) {
      rules.push(fn);
    },
    turnRules(wake) {
      for (const fn of rules) {
        try {
          const limits = fn(wake);
          if (limits) return limits;
        } catch (e) {
          // A broken rule is skipped: P6's own notice tools still keep their limits by construction.
          log.warn({ err: e }, 'a turn rule failed; the next rule decides');
        }
      }
      return null;
    },
    renderWake,
    async build(i) {
      const names = new Map(i.pack.trip.people.map((p) => [p.person_id, personName(p.name)]));
      const seqs = new Map(i.pack.messages.map((m) => [m.message_id, m.seq]));
      // After a fold, "the story so far" stands for every message before chatFromSeq.
      const view = await storyOf(i.tripId);
      const fromSeq = view?.chatFromSeq ?? 0;
      const lines = i.pack.messages
        .filter((m) => m.seq >= fromSeq)
        .map((m) => ({
          seq: m.seq,
          go: m.author.kind === 'go',
          line: chatLine(m, (id) => names.get(id) ?? 'Someone who left', (id) => seqs.get(id)),
          mine: m.reactions.filter((r) => r.person_id == null).map((r) => defuse(oneLine(r.emoji))),
        }))
        .filter((x): x is { seq: number; go: boolean; line: string; mine: string[] } => x.line !== null);

      // New since the last turn: what Go has not seen, at most the newest 25. Everything before is the chat.
      // Go's own messages are never new to Go: the reply it posted after its last turn stays in the chat.
      let split = lines.findIndex((x) => x.seq > i.seenSeq && !x.go);
      if (split < 0) split = lines.length;
      split = Math.max(split, lines.length - NEW_MAX);
      const chat = lines.slice(0, split).map((x) => x.line);
      // A new line says which reactions Go already put on it (the reflex's quiet ✅), so the turn does not try them again.
      // Only new lines: a reaction added to an older message would change a cached chat block's bytes.
      const fresh = lines.slice(split).map((x) => (x.mine.length ? `${x.line} [you reacted ${x.mine.join(' ')}]` : x.line));

      const user: TextBlock[] = [];
      const storyBlock = view?.story ? dataBlock('the story so far', [defuse(view.story)]) : null;
      if (chat.length || storyBlock) {
        user.push({ type: 'text', text: '# The trip chat so far, oldest first' });
        if (storyBlock) user.push({ type: 'text', text: storyBlock });
        const first = user.length;
        for (let c = 0; c * CHUNK < chat.length; c++) {
          user.push({ type: 'text', text: dataBlock(`chat, part ${c + 1}`, chat.slice(c * CHUNK, (c + 1) * CHUNK)) });
        }
        // The chat's marker sits on the last FULL block: its bytes never change as the chat grows, so the next turn
        // reads the cache up to here. Block c is user[first + c]. With no full block yet, the story block takes the
        // marker: its bytes change only at a fold.
        const full = Math.floor(chat.length / CHUNK);
        const at = full > 0 ? first + full - 1 : storyBlock ? first - 1 : -1;
        const last = at >= 0 ? user[at] : undefined;
        if (last) user[at] = { ...last, cache_control: HOUR };
      } else {
        user.push({ type: 'text', text: '# The trip chat so far\nNothing yet.' });
      }

      const now: string[] = [`# Right now\nIt is ${formatTime(i.now, i.tz)} where the trip is (${i.tz}).`];
      for (const p of providers) {
        try {
          const s = await p.render(i.tripId, i.wake);
          if (s) now.push(`## ${p.name}\n${s}`);
        } catch (e) {
          log.warn({ err: e, block: p.name }, 'a right-now block failed; the turn goes on without it');
        }
      }
      const woke = i.wake.map((w) => `- ${renderWake(w, i.pack)}`);
      for (const n of notes) {
        try {
          const text = n(i.wake, i.pack);
          if (text) woke.push(`- ${text}`);
        } catch (e) {
          log.warn({ err: e }, 'a wake note failed; the turn goes on without it');
        }
      }
      now.push(`## Why you woke\n${woke.join('\n') || '- nothing in particular'}`);
      user.push({ type: 'text', text: now.join('\n\n') });
      user.push({
        type: 'text',
        text: fresh.length ? `# New since your last turn\n${dataBlock('new messages', fresh)}` : '# New since your last turn\nNothing new.',
      });

      return {
        system: [{ type: 'text', text: GO_RULES, cache_control: HOUR }],
        user,
        newestSeq: Math.max(i.seenSeq, ...lines.map((x) => x.seq)),
        chatLines: chat.length,
      };
    },
  };
}
