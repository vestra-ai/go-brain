/**
 * CONTEXT_APPEND_V1 (harness to nine, C1): the prefix is never rewritten mid-session.
 *
 * MEASURED (2026-10-02). Inside one run the system prompt is built once, at the prologue, and
 * every round and warm turn reuses it. What moves it is the RUN boundary: a cold start after the
 * box slept or redeployed, a continuation after a pause, a re-drive. Each one re-renders the
 * whole instruction stack from the live world (apps/sandbox run-driver), and these layers can
 * come out different from the run before, in the same session:
 *   nami                user.md kernel + week.md, re-read per run (rewritten on every debounced push)
 *   connected_accounts  the account roster (a second account connected mid-session)
 *   identity            absent until the profile fetch heals (a lazy re-kick), then present
 *   tool_search         the deferred tool set (an app connected, a flag flipped)
 *   operational         .forge/INSTRUCTIONS.md, read per run (the agent edits it itself)
 *   ability_fragments, ability_catalog   abilities installed or removed
 *   nami_wiki           appears once, when the wiki lands in the memory tree
 *   situation           unproduced today; kept, a resumed snapshot can carry it
 *   tool_index          TOOL_DEFER_WIDE_V1's index, appended by the engine (tool-search-session)
 *   session_start       SessionStart hook context, which was PREPENDED to the system prompt
 * Prod mirror, 7 days to 2026-10-02: 170 sessions, 22 extra cold runs inside a session and 31
 * resumed pauses, each a point where any of the above moving rewrote the system prompt and
 * every byte of history after it missed the provider cache. Every other layer is deploy- or
 * process-static or pinned by the journal: re-rendered as today, so a deploy still costs one
 * cold prefix, exactly as before.
 *
 * TWO KINDS OF CHANGE.
 *   APPEND (`nami`, `nami_wiki`, `situation`, `tool_search`, `tool_index`, `session_start`):
 *     context the model reads, never a rule it must obey over its instructions. The session's
 *     first texts stay in the system prompt and a change is told as ONE appended item.
 *   REBUILD (`identity`, `connected_accounts`, `operational`, `ability_fragments`,
 *     `ability_catalog`): who the agent works for, which account to act as, the workspace's
 *     rules, the abilities it has. Current truth must never live only in a user-role message
 *     arguing with the system prompt (the 08-04 wrong-signature class), so a change here
 *     serves a FRESH prompt, freezes it as the session's new base, and tells the model once
 *     that earlier context updates no longer apply. Kept as hashes only: their bytes are
 *     never stored.
 *
 * THE RECORD WINS ONCE IT EXISTS. The flag only decides whether a NEW session is frozen. A
 * session that has a record keeps being held with the flag off, because its earlier updates
 * are still in view claiming to be current; a fresh prompt beside them would let stale facts
 * outrank it. Any other stand-down (the prompt was not built from its layers, a record or an
 * update too big for the mirror) releases the record and tells the model, once, that earlier
 * updates no longer apply.
 *
 * STORED ONCE. The frozen record holds the APPEND texts the held prompt needs and a hash per
 * part; an update's text lives only in its own user entry (`injected: 'context_update'`, one
 * text block per part) and its record holds hashes and block indices. Comparison uses each
 * layer's `stableText` when its producer tagged one, so the memory block's hour count never
 * re-sends an unchanged memory. After a compaction, `reassertSessionContext` copies the
 * blocks of any update the cut summarized away into a new one.
 *
 * SETTINGS (C7). The run's model is a REBUILD part (a hash only): provider caches are per model,
 * so holding the old model's prompt gains nothing, and the tool index and the ability catalog's
 * size limit are the new model's to set; a model change serves a fresh prompt. The reasoning
 * effort its wire resolves (Transport.reasoningEffort) is an APPEND part, never in the system
 * prompt: frozen silently, told when it changes. Neither ever names a model.
 *
 * Inert (undefined: the caller does exactly what it did before) without a journal or the
 * layers, on a session never frozen while the flag is off, and on a read failure. Never throws.
 */
import type { HarnessContext } from '../contract/harness.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { JournalEntry, NewEntry } from '../contract/journal.js';
import type { Journal } from '../kernel/index.js';
import type { NativeConfigLike } from './native-config-like.js';
import type { NativeConfig } from './native-config.js';
import { assembleInstructionStack, hash12, type InstructionLayer, type InstructionLayerId } from '../contract/instruction-stack.js';
import { contextAppendEnabled } from '../policy/feature-flags.js';
import { base } from './journal-entry-base.js';

/** The session's base: the APPEND texts the held prompt renders, and every part's hash. Or a release. */
export const CONTEXT_FROZEN_KEY = 'context_frozen';
/** What one update told: its entry, and per part the hash and the block that carries it. */
export const CONTEXT_TOLD_KEY = 'context_told';
/** The `payload.injected` value of every entry this module writes. */
export const CONTEXT_UPDATE_DOOR = 'context_update' as const;

const APPEND_LAYERS: readonly InstructionLayerId[] = ['tool_search', 'nami_wiki', 'situation', 'nami'];
const REBUILD_LAYERS: readonly InstructionLayerId[] = [
  'identity', 'connected_accounts', 'operational', 'ability_fragments', 'ability_catalog',
];
const TOOL_INDEX = 'tool_index';
const SESSION_START = 'session_start';
const MODEL = 'model';
const EFFORT = 'effort';
/** Every part whose change serves a fresh prompt. */
const REBUILD_KEYS: readonly string[] = [...REBUILD_LAYERS, MODEL];

/** The APPEND parts in the order they are told, and the name each carries in the update. */
const PART_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['tool_search', 'tools you can load'],
  [TOOL_INDEX, 'tools you can load'],
  ['nami_wiki', 'wiki'],
  ['situation', 'situation'],
  ['nami', 'memory'],
  [EFFORT, 'reasoning effort'],
  [SESSION_START, 'session start'],
];

/** Below the mirror's whole-entry cap (MIRROR_MAX_ENTRY_BYTES, 250 KB): past it a record degrades
 *  to a context note in the mirror, so the rail releases instead. */
const MAX_RECORD_CHARS = 200_000;

type Texts = Record<string, string>;
type Hashes = Record<string, string>;
interface Part { text: string; hash: string }
type Parts = Record<string, Part>;

interface Told {
  uuid: string;
  parts: Record<string, { hash: string; block: number }>;
  notice: boolean;
}

interface Ledger {
  /** The base the system prompt is held at; null once released. */
  held: { texts: Texts; hashes: Hashes } | null;
  /** Updates told since that base, in order. */
  told: Told[];
  /** An update was told (in any base) after the last refresh notice. */
  owesNotice: boolean;
  /** Entry uuids in the model's view. */
  visible: Set<string>;
  /** This module's own user entries, by uuid (the blocks a re-tell copies). */
  updates: Map<string, JournalEntry>;
}

/** What the prologue built: the product's prompt, plus the engine's wide tool index when one rides it. */
export interface SessionPrefixInput {
  system: string;
  /** TOOL_DEFER_WIDE_V1's index exactly as appended to `system`; '' or absent when none. */
  toolIndex?: string;
  /** SessionStart hooks' additionalContext; '' when none. */
  sessionStart: string;
  /** C7: the run's model and the reasoning effort its wire resolves for it (absent when none). */
  settings?: { model: string; effort?: string | undefined };
}

/** The effort part's words: the effort alone, never a model id. */
export function effortText(effort: string | undefined): string {
  return effort ? `Reasoning effort is now ${effort}.` : '';
}

function render(layers: readonly InstructionLayer[], toolIndex: string): string {
  const body = assembleInstructionStack([...layers], 'native');
  if (!toolIndex) return body;
  return body ? `${body}\n\n${toolIndex}` : toolIndex;
}

/** The fresh layers with every APPEND one replaced by the held text (REBUILD layers render fresh: held only while unchanged). */
function withTexts(layers: readonly InstructionLayer[], texts: Texts): InstructionLayer[] {
  const kept = layers.filter((l) => !APPEND_LAYERS.includes(l.id));
  return [...kept, ...APPEND_LAYERS.map((id) => ({ id, text: texts[id] ?? '', static: false }))];
}

function freshParts(layers: readonly InstructionLayer[], toolIndex: string, sessionStart: string, settings?: SessionPrefixInput['settings']): Parts {
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  const out: Parts = {};
  for (const id of [...APPEND_LAYERS, ...REBUILD_LAYERS]) {
    const layer = byId.get(id);
    out[id] = { text: layer?.text.trim() ?? '', hash: hash12((layer?.stableText ?? layer?.text ?? '').trim()) };
  }
  out[TOOL_INDEX] = { text: toolIndex, hash: hash12(toolIndex) };
  out[SESSION_START] = { text: sessionStart, hash: hash12(sessionStart) };
  out[MODEL] = { text: '', hash: hash12(settings?.model ?? '') };
  out[EFFORT] = { text: effortText(settings?.effort), hash: hash12(settings?.effort ?? '') };
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strings = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

async function readLedger(j: Journal): Promise<Ledger | undefined> {
  let seen = false;
  let held: Ledger['held'] = null;
  let told: Told[] = [];
  let owesNotice = false;
  const updates = new Map<string, JournalEntry>();
  for (const e of await j.snapshot()) {
    const p = e.payload;
    if (p.type === 'user' && p.injected === CONTEXT_UPDATE_DOOR) updates.set(e.uuid, e);
    if (p.type !== 'custom' || !isObj(p.data)) continue;
    if (p.key === CONTEXT_FROZEN_KEY) {
      seen = true;
      told = [];
      held = p.data.released === true ? null : { texts: strings(p.data.texts), hashes: strings(p.data.hashes) };
    } else if (p.key === CONTEXT_TOLD_KEY && typeof p.data.entryUuid === 'string') {
      const notice = p.data.notice === true;
      const parts: Told['parts'] = {};
      if (isObj(p.data.parts)) {
        for (const [id, v] of Object.entries(p.data.parts)) {
          if (isObj(v) && typeof v.hash === 'string' && typeof v.block === 'number') parts[id] = { hash: v.hash, block: v.block };
        }
      }
      // A refresh notice voids every update before it: the model was told they no longer apply.
      if (notice) told = [];
      told.push({ uuid: p.data.entryUuid, parts, notice });
      owesNotice = !notice;
    }
  }
  if (!seen) return undefined;
  const visible = new Set((await j.project()).messages.map((m) => m.uuid));
  return { held, told, owesNotice, visible, updates };
}

/** The hash the model can still see for a part: the base, overlaid by every visible update since. */
function visibleHash(ledger: Ledger, id: string): string {
  let h = ledger.held?.hashes[id] ?? hash12('');
  for (const t of ledger.told) if (ledger.visible.has(t.uuid) && t.parts[id]) h = t.parts[id].hash;
  return h;
}

function userEntry(ctx: HarnessContext<NativeConfigLike>, blocks: string[]): NewEntry {
  return {
    ...base(ctx),
    principal: { kind: 'system' },
    payload: { type: 'user', blocks: blocks.map((text) => ({ type: 'text', text }) as ContentBlock), injected: CONTEXT_UPDATE_DOOR },
  };
}

function record(ctx: HarnessContext<NativeConfigLike>, key: string, data: unknown): NewEntry {
  return { ...base(ctx), principal: { kind: 'system' }, payload: { type: 'custom', key, data } };
}

const UPDATE_OPEN =
  '<context_update>\nPart of your standing context changed since this session began. Each part ' +
  'below replaces what you were told about it before, in your instructions or an earlier update; ' +
  'where the two differ, this one is current. Nothing here is a request from the person.';
const UPDATE_CLOSE = '</context_update>';
const REFRESH_NOTICE =
  '<context_update>\nYour instructions were refreshed for this run. Every earlier context update ' +
  'in this conversation no longer applies: your instructions are current. Nothing here is a ' +
  'request from the person.\n</context_update>';

/** One part's block. Plain words, no em dashes, never names the provider. */
export function renderContextPart(id: string, text: string): string {
  const name = PART_NAMES.find(([k]) => k === id)?.[1] ?? id;
  return `<part name="${name}">\n${text.trim() || 'This part no longer applies.'}\n</part>`;
}

/** One part as told: its rendered block and the hash of what it says. */
interface Told1 { id: string; block: string; hash: string }

/**
 * Append ONE update carrying these parts, one text block each, in the told order. False (nothing
 * appended) when it would pass the mirror cap.
 */
async function tellBlocks(j: Journal, ctx: HarnessContext<NativeConfigLike>, items: Told1[]): Promise<boolean> {
  if (items.length === 0) return true;
  const ordered = PART_NAMES.map(([id]) => items.find((x) => x.id === id)).filter((x): x is Told1 => x !== undefined);
  const blocks = [UPDATE_OPEN, ...ordered.map((x) => x.block), UPDATE_CLOSE];
  if (blocks.reduce((n, b) => n + b.length, 0) > MAX_RECORD_CHARS) return false;
  const entry = await j.append(userEntry(ctx, blocks));
  const parts: Told['parts'] = {};
  ordered.forEach((x, i) => {
    parts[x.id] = { hash: x.hash, block: i + 1 };
  });
  await j.append(record(ctx, CONTEXT_TOLD_KEY, { entryUuid: entry.uuid, parts }));
  return true;
}

/** Tell the model these parts' current texts. */
function tell(j: Journal, ctx: HarnessContext<NativeConfigLike>, parts: Array<[string, Part]>): Promise<boolean> {
  return tellBlocks(j, ctx, parts.map(([id, p]) => ({ id, block: renderContextPart(id, p.text), hash: p.hash })));
}

/** Earlier updates no longer apply: said once, only when one was told since the last time it was said. */
async function noticeIfOwed(j: Journal, ctx: HarnessContext<NativeConfigLike>, ledger: Ledger | undefined): Promise<void> {
  if (!ledger?.owesNotice) return;
  const entry = await j.append(userEntry(ctx, [REFRESH_NOTICE]));
  await j.append(record(ctx, CONTEXT_TOLD_KEY, { entryUuid: entry.uuid, notice: true }));
}

/** Stop holding: the prompt is served as built from here on, and earlier updates are voided. */
async function release(j: Journal, ctx: HarnessContext<NativeConfigLike>, ledger: Ledger | undefined): Promise<void> {
  if (!ledger?.held) return;
  // The notice FIRST: if the record's append then fails, the debt is paid and the reader has
  // already voided the earlier updates (a notice resets them), so the next run re-tells current.
  await noticeIfOwed(j, ctx, ledger);
  await j.append(record(ctx, CONTEXT_FROZEN_KEY, { released: true }));
}

/**
 * Freeze the fresh prompt as the session's base (a first run, a REBUILD change, an update too
 * big to tell). Returns the prompt to serve, or undefined when even the base is too big (released).
 */
async function freezeFresh(
  j: Journal,
  ctx: HarnessContext<NativeConfigLike>,
  ledger: Ledger | undefined,
  fresh: Parts,
  system: string,
): Promise<string | undefined> {
  const texts: Texts = {};
  // The effort is frozen silently (a run never tells the model about itself); SessionStart context
  // is told below. Neither is ever rendered into the system prompt.
  for (const [id] of PART_NAMES) texts[id] = id === SESSION_START ? '' : (fresh[id]?.text ?? '');
  const hashes: Hashes = Object.fromEntries(Object.entries(fresh).map(([id, p]) => [id, p.hash]));
  hashes[SESSION_START] = hash12(''); // never in the system prompt: told below
  if (JSON.stringify(texts).length > MAX_RECORD_CHARS) {
    await release(j, ctx, ledger);
    return undefined;
  }
  await noticeIfOwed(j, ctx, ledger); // before the base, for the same reason as in release()
  await j.append(record(ctx, CONTEXT_FROZEN_KEY, { texts, hashes }));
  const start = fresh[SESSION_START];
  if (start && start.text) await tell(j, ctx, [[SESSION_START, start]]);
  return system;
}

/** The system prompt a run serves, and the layers it was rendered from (a held base's own texts). */
export interface HeldSession {
  system: string;
  layers: readonly InstructionLayer[];
}

/**
 * The system prompt this run serves, or undefined when the rail is inert (the caller then serves
 * `input.system` and prepends SessionStart context, as before). Called once per run, after the
 * prologue and SessionStart, before the first turn: what it appends lands ahead of the turn.
 */
export async function holdSessionPrefix(
  ctx: HarnessContext<NativeConfig>,
  input: SessionPrefixInput,
): Promise<string | undefined> {
  return (await holdSession(ctx, input))?.system;
}

/**
 * holdSessionPrefix, with the layers the served prompt was rendered from: the fresh layers when
 * it froze a new base, the base's texts (withTexts) when it serves a held one. A cut measured
 * from these (instruction-stack.ts memorySpan) is the same on every run of a session.
 */
export async function holdSession(
  ctx: HarnessContext<NativeConfig>,
  input: SessionPrefixInput,
): Promise<HeldSession | undefined> {
  const j = ctx.config.journal;
  const layers = ctx.config.instructionLayers;
  if (!j || !layers) return undefined;
  const where = `[context-append] task=${ctx.taskId.slice(0, 8)}`;
  const servedFresh = (system: string | undefined): HeldSession | undefined => (system === undefined ? undefined : { system, layers });
  try {
    const ledger = await readLedger(j);
    // The flag decides only whether a session is frozen; a session already frozen stays held.
    if (!ledger && !contextAppendEnabled()) return undefined;
    const toolIndex = input.toolIndex ?? '';
    if (render(layers, toolIndex) !== input.system) {
      console.warn(`${where} system prompt was not built from its layers; serving it as built`);
      await release(j, ctx, ledger);
      return undefined;
    }
    const fresh = freshParts(layers, toolIndex, input.sessionStart, input.settings);
    if (!ledger || !ledger.held) {
      return contextAppendEnabled() ? servedFresh(await freezeFresh(j, ctx, ledger, fresh, input.system)) : undefined;
    }
    const held = ledger.held;
    if (REBUILD_KEYS.some((id) => fresh[id]?.hash !== (held.hashes[id] ?? hash12('')))) {
      return servedFresh(await freezeFresh(j, ctx, ledger, fresh, input.system));
    }
    const changed = PART_NAMES.map(([id]) => id).filter((id) => fresh[id]?.hash !== visibleHash(ledger, id));
    if (!(await tell(j, ctx, changed.map((id) => [id, fresh[id]!])))) {
      return servedFresh(await freezeFresh(j, ctx, ledger, fresh, input.system));
    }
    const heldLayers = withTexts(layers, held.texts);
    return { system: render(heldLayers, held.texts[TOOL_INDEX] ?? ''), layers: heldLayers };
  } catch (err) {
    console.warn(`${where} standing down for this run: ${String(err)}`);
    return undefined;
  }
}

/**
 * The layer ids whose drift a HELD session owns: its APPEND layers, whose change is appended, so a
 * hash drift there is the rail working, not a cache regression. None when the session is not held
 * (never frozen, or released). The continue path's drift warning (sandbox prompt-drift-warn.ts)
 * skips exactly these, flag or no flag (the record wins), and keeps watching every other layer.
 * Never throws: an unreadable journal skips nothing.
 */
export async function heldAppendLayerIds(j: Journal | undefined): Promise<readonly string[]> {
  if (!j) return [];
  try {
    return (await readLedger(j))?.held ? APPEND_LAYERS : [];
  } catch {
    return [];
  }
}

/**
 * After a compaction's splice: every part whose latest update the cut summarized away is told
 * again (its block copied), so the model never falls back to the base texts the system prompt
 * still carries. Runs on any held session, flag or no flag (the record wins). Never throws.
 */
export async function reassertSessionContext(j: Journal, ctx: HarnessContext<NativeConfigLike>): Promise<void> {
  try {
    const ledger = await readLedger(j);
    if (!ledger?.held) return;
    const latest = new Map<string, Told>();
    for (const t of ledger.told) for (const id of Object.keys(t.parts)) latest.set(id, t);
    const lost: Told1[] = [];
    for (const [id, t] of latest) {
      if (ledger.visible.has(t.uuid)) continue;
      const entry = ledger.updates.get(t.uuid);
      const block = entry?.payload.type === 'user' ? entry.payload.blocks[t.parts[id]!.block] : undefined;
      // The block IS the rendered part, so the copy is byte-for-byte what was told.
      if (block?.type === 'text') lost.push({ id, block: (block as { text: string }).text, hash: t.parts[id]!.hash });
    }
    await tellBlocks(j, ctx, lost);
  } catch (err) {
    console.warn(`[context-append] task=${ctx.taskId.slice(0, 8)} re-tell after compaction failed: ${String(err)}`);
  }
}
