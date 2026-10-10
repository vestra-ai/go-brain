import type * as C from '@go/contract';
import type { DeskItem, DeskKind } from '../desk/desk.js';
import type { Log } from '../log.js';
import type { TripPack } from '../trips/pack.js';
import { chatLine, dataBlock, defuse, oneLine, personName, roomView, type Forgotten } from './fence.js';
import { GO_RULES } from './rules.js';
import type { TurnCtx } from './tools.js';

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
/** P2's forget: who Go was asked to forget in a trip, read each turn. */
export interface ForgottenProvider {
  get(tripId: string): Promise<Forgotten>;
  /** Who had Go forget them in another trip, with the change number up to which Go's own messages naming them are hidden. */
  elsewhere?(tripId: string): Promise<Forgotten>;
}

/** A turn that is over (it ran, or gave up after its last attempt), with the messages it handled. */
export interface TurnEnd {
  tripId: string;
  turnId: string;
  messageIds: string[];
  /** The turn answered: its words went out. A live card it left open ends done then, never failed beside the answer. */
  answered?: boolean;
}

/**
 * A lane's answer with no model call: given the turn's wake items, it puts its cards and their lines in ctx and says
 * true, or says false and the turn goes to the model (P4's finished early search for a plain ask).
 */
export type DirectAnswer = (i: { tripId: string; wake: DeskItem[]; pack: TripPack; ctx: TurnCtx }) => Promise<boolean>;

/**
 * A card a lane puts on the turn's own post, first, with one line after Go's words, so the room gets one message, never
 * two in a row (the ixigo login on Go's hello). Asked once, just before the post; null for none.
 */
export type TurnCard = (i: { tripId: string; turnId: string; wake: DeskItem[]; pack: TripPack }) => Promise<{ card: C.Card; line: string } | null>;

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
  /** An order for this reply, said once at the very end of the prompt, after the newest messages and outside their fence (P1's note for an ask). */
  addEndNote(render: (items: DeskItem[], pack: TripPack) => string | null): void;
  /** P2's fold: the story block sits right before the chat chunks (inside the data fence), and the chat starts at chatFromSeq. */
  setStory(p: StoryProvider): void;
  /** P2's forget: a forgotten person's earlier lines are hidden in the chat, and "right now" says who asked Go to forget them. */
  setForgotten(p: ForgottenProvider): void;
  /** P6's proactive bar: limits for a turn Go woke for on its own; null means no limits. */
  addTurnRules(fn: (wake: DeskItem[]) => TurnLimits | null): void;
  /** Called once a turn is over, so a lane ends what the turn left open (P4's live search cards). */
  addTurnEnd(fn: (t: TurnEnd) => void): void;
  /** A lane's answer with no model call, tried before the model in registration order; the first true wins. */
  addDirect(fn: DirectAnswer): void;
  /** A lane's card on the turn's own post, with its line (TurnCard). */
  addTurnCard(fn: TurnCard): void;
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
  /** Who was forgotten when the prompt was built: lines that arrive during the turn are drawn with the same. */
  forgotten: Forgotten;
}

export type ContextImpl = Context & {
  build(i: BuildInput): Promise<BuiltPrompt>;
  renderWake(item: DeskItem, pack: TripPack): string;
  /** The first rule's answer for these wake items, or null for no limits. */
  turnRules(wake: DeskItem[]): TurnLimits | null;
  /** Tells every addTurnEnd lane the turn is over; never throws. */
  turnEnded(t: TurnEnd): void;
  /** Whether a lane answered the turn with no model call; a lane that throws is logged and the model answers. */
  direct(i: Parameters<DirectAnswer>[0]): Promise<boolean>;
  /** Every lane's card for this turn's post, in registration order; a lane that throws is logged and left out. */
  turnCards(i: Parameters<TurnCard>[0]): Promise<Array<{ card: C.Card; line: string }>>;
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

/**
 * Said under "right now" while someone in the trip has used Forget me. Their earlier lines are hidden, but Go's own
 * earlier answers about them are not (drill t_p1b_2c72baaa: "Kabir doesn't drink" right after Kabir's forget), and Go
 * must know the forget is done, so it never sends them to Forget me again. The room is never told who used it: the
 * person who did is told on a card pinned to them (memory/people.ts forgetNotice).
 */
export function forgottenNote(pack: TripPack, forgotten: Forgotten): string | null {
  const names = [...forgotten.keys()].map((id) => personName(pack.trip.people.find((p) => p.person_id === id)?.name ?? 'Someone who left'));
  if (names.length === 0) return null;
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const them = names.length === 1 ? who : 'them';
  return (
    `${who} used "Forget me in this trip" in the App, so Go forgot what it knew about them, and their earlier messages are hidden. ` +
    `Never repeat anything about ${them} from earlier in the chat, your own messages included. ` +
    `If someone asks about something you no longer know, say you don't have it, and never name ${them} or tie ${them} to it yourself. ` +
    'Never tell the room that anyone used Forget me or asked you to forget them: only the person who did it is told, on their own card.'
  );
}

export function createContext(log: Log): ContextImpl {
  const providers: NowProvider[] = [];
  const wakes = new Map<DeskKind, Array<(item: DeskItem, pack: TripPack) => string | null>>();
  const rules: Array<(wake: DeskItem[]) => TurnLimits | null> = [];
  const notes: Array<(items: DeskItem[], pack: TripPack) => string | null> = [];
  const endNotes: Array<(items: DeskItem[], pack: TripPack) => string | null> = [];
  const turnEnds: Array<(t: TurnEnd) => void> = [];
  const directs: DirectAnswer[] = [];
  const riders: TurnCard[] = [];
  let story: StoryProvider | null = null;
  let forgottenFrom: ForgottenProvider | null = null;

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
    addEndNote(render) {
      endNotes.push(render);
    },
    setStory(p) {
      if (story) throw new Error('the story so far is already set');
      story = p;
    },
    setForgotten(p) {
      if (forgottenFrom) throw new Error('the forgotten provider is already set');
      forgottenFrom = p;
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
    addTurnEnd(fn) {
      turnEnds.push(fn);
    },
    addDirect(fn) {
      directs.push(fn);
    },
    addTurnCard(fn) {
      riders.push(fn);
    },
    async turnCards(i) {
      const out: Array<{ card: C.Card; line: string }> = [];
      for (const fn of riders) {
        try {
          const rider = await fn(i);
          if (rider) out.push(rider);
        } catch (e) {
          log.warn({ err: e, trip: i.tripId }, "a lane's card for the turn failed; the post goes without it");
        }
      }
      return out;
    },
    async direct(i) {
      for (const fn of directs) {
        try {
          if (await fn(i)) return true;
        } catch (e) {
          log.warn({ err: e, trip: i.tripId }, 'a direct answer failed; the model answers');
        }
      }
      return false;
    },
    turnEnded(t) {
      for (const fn of turnEnds) {
        try {
          fn(t);
        } catch (e) {
          log.warn({ err: e, trip: t.tripId, turn: t.turnId }, 'a turn-end hook failed');
        }
      }
    },
    renderWake,
    async build(i) {
      // Never guessed: a turn that cannot read who was forgotten fails and runs again, rather than show their words.
      const forgotten: Forgotten = forgottenFrom ? await forgottenFrom.get(i.tripId) : new Map();
      const elsewhere: Forgotten = forgottenFrom?.elsewhere ? await forgottenFrom.elsewhere(i.tripId) : new Map();
      const room = roomView(i.pack, forgotten, elsewhere);
      // After a fold, "the story so far" stands for every message before chatFromSeq.
      const view = await storyOf(i.tripId);
      const fromSeq = view?.chatFromSeq ?? 0;
      const lines = i.pack.messages
        .filter((m) => m.seq >= fromSeq)
        .map((m) => ({
          seq: m.seq,
          go: m.author.kind === 'go',
          line: chatLine(m, room),
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
      const gone = forgottenNote(i.pack, forgotten);
      if (gone) now.push(`## asked Go to forget\n${gone}`);
      const said = (renders: typeof notes): string[] =>
        renders.flatMap((n) => {
          try {
            return n(i.wake, i.pack) || [];
          } catch (e) {
            log.warn({ err: e }, 'a wake note failed; the turn goes on without it');
            return [];
          }
        });
      const woke = [...i.wake.map((w) => renderWake(w, i.pack)), ...said(notes)].map((line) => `- ${line}`);
      now.push(`## Why you woke\n${woke.join('\n') || '- nothing in particular'}`);
      user.push({ type: 'text', text: now.join('\n\n') });
      // The end notes close the last block, after the fence: the last thing read before the reply, in the same block, so
      // the prompt's blocks and cache markers stay as they were.
      const newest = fresh.length ? `# New since your last turn\n${dataBlock('new messages', fresh)}` : '# New since your last turn\nNothing new.';
      user.push({ type: 'text', text: [newest, ...said(endNotes)].join('\n\n') });

      return {
        system: [{ type: 'text', text: GO_RULES, cache_control: HOUR }],
        user,
        newestSeq: Math.max(i.seenSeq, ...lines.map((x) => x.seq)),
        chatLines: chat.length,
        forgotten,
      };
    },
  };
}
