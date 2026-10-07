/**
 * Live only: where each ask's reply time goes, on the run's own clock. From the moment the ask's last line reached the
 * simulator: when Go's desk had it due (so whether it waited), typing, the turn's start, each model call (start, first
 * word, end, output tokens) with the tools it asked for, and Go's post: its text, how long it was, and the request of the
 * call that wrote it. Go's desk and turns come from its own tables (Timeline); the rest from what the replay recorded.
 */
import type { Block, MessageBody } from './requests.js';
import { groupsOf, type ReplayRecord } from './score.js';

/** Read from Go's tables before the run's database is dropped. Times are wall clock (ms). */
export interface Timeline {
  desk: Array<{ ref: string; kind: string; dueMs: number; turnId: string | null }>;
  turns: Array<{ turnId: string; startedMs: number; postedMs: number | null; endedMs: number | null }>;
  /** Go's writes to the Server (go_requests): when each first went out, when its answer came, and how many attempts it took. */
  writes?: Array<{ requestId: string; turnId: string | null; method: string; attempts: number; sentMs: number | null; answeredMs: number | null; error: string | null }>;
}

export interface AskTiming {
  /** The ask's last line in the chat. */
  line: number;
  /** All in ms after that line reached the simulator; null when it did not happen. */
  dueMs: number | null;
  /** Due later than 500 ms after it arrived: the ask waited for more lines. */
  waited: boolean | null;
  typingMs: number | null;
  turnStartMs: number | null;
  calls: Array<{ startMs: number; firstWordMs: number | null; endMs: number | null; toolsAfter: string[]; outputTokens: number | null }>;
  postMs: number | null;
  /** The answer Go posted: its text, its length, and the output tokens of the call that wrote it (the turn's last). Null with no post. */
  reply: { text: string; chars: number; sentences: number; outputTokens: number | null } | null;
  /** The request of the call that wrote the answer (the turn's last), exactly as Go sent it. Null with no call. */
  request: MessageBody | null;
  /** Before the turn (Go reading the line, any wait, the desk picking it up), the model calls, the gaps between them (the tools ran there), and from the last call to the post. */
  parts: { beforeTurnMs: number | null; modelMs: number; betweenMs: number; afterModelMs: number | null };
  /** The tools the turn's last call asked for (card tools such as put_to_vote run after it, and no request follows). */
  lastTools: string[];
  /**
   * The turn's writes to the Server sent after its last call ended, in ms after the ask's line: a retry shows as attempts > 1,
   * and each time the frame reached the simulator shows whether the first one got there.
   */
  afterModel: Array<{ method: string; sentMs: number | null; arrivedMs: number[]; answeredMs: number | null; attempts: number; error: string | null }>;
}

const WAITED_MS = 500;

/**
 * The sentences in a reply: each run ending in ".", "!" or "?" before a space or the end (so "6.30" or "₹5,640.50" is
 * not an end), and a last one that ends without a mark ("see you there 🎉").
 */
export function sentencesIn(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const ends = t.match(/[.!?]+(?=\s|$)/g)?.length ?? 0;
  return ends + (/[.!?]$/.test(t) ? 0 : 1);
}

/** The tool calls the model made in the round before this request: the tool_use blocks of its last assistant message. */
function toolsIn(content: string | Block[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b['type'] === 'tool_use' && typeof b['name'] === 'string' ? [b['name']] : []));
}

export function askTimings(rec: ReplayRecord, tl: Timeline): AskTiming[] {
  const byLine = new Map(rec.delivered.map((d) => [d.i, d]));
  // The composer's own calls carry tools; side passes (notes, fold) do not, even on the same model.
  const calls = rec.requests.filter((r) => r.role === 'composer' && (r.body.tools?.length ?? 0) > 0).sort((a, b) => a.realMs - b.realMs);
  const out: AskTiming[] = [];
  for (const g of groupsOf(rec.chat)) {
    if (g.expect !== true) continue;
    const line = g.lines[g.lines.length - 1]!;
    const d = byLine.get(line);
    if (d === undefined || d.messageId === undefined) continue;
    const t0 = d.realMs;
    const rel = (ms: number | null | undefined): number | null => (ms === null || ms === undefined ? null : ms - t0);
    const item = tl.desk.find((x) => x.kind === 'message' && x.ref === d.messageId);
    const turn = item?.turnId ? tl.turns.find((t) => t.turnId === item.turnId) : undefined;
    const inTurn = turn === undefined ? [] : calls.filter((r) => r.realMs >= turn.startedMs && r.realMs <= (turn.endedMs ?? Number.POSITIVE_INFINITY));
    const timed = inTurn.map((r, k) => ({
      startMs: r.realMs - t0,
      firstWordMs: rel(r.firstTokenMs),
      endMs: rel(r.doneMs),
      toolsAfter: toolsIn(inTurn[k + 1]?.body.messages.filter((m) => m.role === 'assistant').at(-1)?.content),
      outputTokens: r.usage?.output_tokens ?? null,
    }));
    const typing = rec.frames.find((f) => f.method === 'typing' && f.params['on'] === true && f.at >= t0);
    const post = rec.frames.find((f) => f.method === 'post_message' && f.at >= (turn?.startedMs ?? t0));
    const turnStartMs = rel(turn?.startedMs);
    const postMs = rel(post?.at);
    const modelMs = timed.reduce((s, c) => s + (c.endMs !== null ? c.endMs - c.startMs : 0), 0);
    let betweenMs = 0;
    for (let k = 1; k < timed.length; k += 1) {
      const prevEnd = timed[k - 1]!.endMs;
      if (prevEnd !== null) betweenMs += timed[k]!.startMs - prevEnd;
    }
    const lastEnd = timed.at(-1)?.endMs ?? null;
    const afterModel = (tl.writes ?? [])
      .filter((w) => turn !== undefined && w.turnId === turn.turnId && w.sentMs !== null && (lastEnd === null || w.sentMs - t0 >= lastEnd))
      .map((w) => ({
        method: w.method,
        sentMs: rel(w.sentMs),
        arrivedMs: rec.frames.filter((f) => f.params['request_id'] === w.requestId).map((f) => f.at - t0),
        answeredMs: rel(w.answeredMs),
        attempts: w.attempts,
        error: w.error,
      }));
    const said = typeof post?.params['text'] === 'string' ? post.params['text'] : null;
    out.push({
      line,
      dueMs: rel(item?.dueMs),
      waited: item === undefined ? null : item.dueMs - t0 > WAITED_MS,
      typingMs: rel(typing?.at),
      turnStartMs,
      calls: timed,
      postMs,
      reply: said === null ? null : { text: said, chars: [...said].length, sentences: sentencesIn(said), outputTokens: timed.at(-1)?.outputTokens ?? null },
      request: inTurn.at(-1)?.body ?? null,
      parts: {
        beforeTurnMs: turnStartMs,
        modelMs,
        betweenMs,
        afterModelMs: postMs !== null && lastEnd !== null ? postMs - lastEnd : null,
      },
      lastTools: inTurn.at(-1)?.toolsOut ?? [],
      afterModel,
    });
  }
  return out;
}
