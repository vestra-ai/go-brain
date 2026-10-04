/**
 * media-watch — the `watch` tool (VIDEO_UNDERSTANDING_V1), successor in shape
 * to the blind-lane `look` tool.
 *
 * Only the Gemini lane takes a video or an audio file in natively (spec §7).
 * Every other model sees a `media` block its dialect drops, and a `files/` copy
 * it can only shell at. `watch` closes that: the blind model POINTS a
 * video-capable model at ONE attached file with a specific question — what
 * happens, what is said, on-screen text, timestamps — and reads the answer.
 * Pull, not push: nothing is watched until the model needs to, and the same
 * file can be re-interrogated with a different question or a different clip.
 *
 * LAYERING: the engine may not import `transports/`, so the describe lane's
 * Transport (and its model id) is INJECTED by the product side, exactly like
 * the main-loop transport. The side call itself mirrors `runSuggestionCall`
 * (offloop-usage.ts): bounded, abortable, never throws out of the tool.
 *
 * METERING: every watch call pushes a SideCallResult into a per-run collector;
 * the harness epilogue folds them into ONE `vision` lane usage event per turn
 * (the lane name stays; its meaning is "a side model looked at media") — side
 * call ≠ turn, own row (#2582).
 */
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { MediaBlock } from '../contract/blocks.js';
import type { HarnessEvent } from '../contract/events.js';
import { modelSupportsVideoInput } from '../contract/model-capabilities.js';
import { videoUnderstandingEnabled } from '../policy/feature-flags.js';
import type { RawToolOptions } from '../tools/tool-types.js';
import type { NormalizedUsage, Transport } from './transport.js';
import type { JournalEntry } from '../contract/journal.js';
import { laneUsageEvent, type SideCallResult } from './offloop-usage.js';

/** The tool's name — referenced by the attachment pointer line. */
export const MEDIA_WATCH_TOOL_NAME = 'watch';

/** Max output for one watch answer (a focused answer, not a transcript dump). */
export const VIDEO_MAX_TOKENS = 800;
/**
 * Hard ceiling on ONE watch call. 270s = 90s for the model call + 180s for a
 * first-time Files API upload: the materialize pass runs INSIDE callModel, so the
 * upload is on this clock too, and a 90s bound would kill a large first watch
 * before the model ever saw the file. The upload is shared and content-hashed, so
 * a call that does time out leaves the bytes cached and a retry starts warm.
 */
export const WATCH_CALL_TIMEOUT_MS = 270_000;

/**
 * Watch calls one TURN may make. Each is a full Gemini request over a video, and
 * `watch` is metered but does not reach the per-turn spend ceiling (that gate
 * counts main-loop rounds), so the count is the bound. Twelve (founder's call,
 * 2026-09-05) lets a model scan a long clip window by window — at the low
 * resolution the tool uses, a ten-minute clip is ~7 credits a read, so the
 * worst case for one turn stays under ~85 credits; a thirteenth is a loop.
 */
export const WATCH_CALLS_PER_TURN = 12;

/** System prompt for the describe lane: answer THE question, from what is there. */
export const VIDEO_DESCRIBE_SYSTEM =
  'You watch videos and listen to audio for an agent that cannot take them in ' +
  'directly. Answer the specific question from what is seen and heard. ' +
  'Transcribe on-screen text and speech exactly when asked. Cite timestamps ' +
  '(m:ss) for anything you locate. If the question cannot be answered from the ' +
  'media, say what IS there instead. Be concise and factual.';

/**
 * The per-call options this tool puts on the block it hands to `pushUser`. A
 * tiny local mirror of transports/gemini-interactions-messages' MediaWatchOptions
 * / MediaBlockForWire — the engine may not import `transports/` (the same rule
 * `look`'s imageDisplayName mirrored filenameFromUrl for). The Gemini projection
 * reads them off the block; no other dialect looks, and nothing is journaled:
 * the journal's block is the FILE, never the way it was watched.
 */
type MediaBlockForCall = MediaBlock & {
  watchOptions?: {
    resolution?: 'low' | 'medium' | 'high';
    startSec?: number;
    endSec?: number;
    strict?: true;
  };
};

export interface MediaWatchDeps {
  /** Live view of the task's attached media, in append (oldest→newest) order. */
  getMedia: () => Promise<MediaBlock[]>;
  /** The DESCRIBE lane: a video-capable Transport + its model id (product-injected). */
  transport: Transport;
  model: string;
  /** Per-run collector the epilogue drains into the `vision` usage lane row. */
  records: SideCallResult[];
  /** The run's abort signal — a user stop also cancels an in-flight watch. */
  signal?: AbortSignal;
  /** Workspace root, for the agent-made `files/<name>` case (no block exists). */
  workspaceDir: string;
}

/**
 * Extension → mime for a file the AGENT made (a cut clip, an exported track); an
 * ATTACHED file already carries its mime on the block and never consults this.
 *
 * A TRUE mirror of the sandbox's MEDIA_MIME_BY_EXT, minus `pdf` — a PDF is read,
 * not watched. Mirrored rather than curated on purpose: a second, narrower list
 * would make `render.avi` watchable when attached and unwatchable when the model
 * exported it, for no reason the model could see. (No `mkv`: it is in neither
 * map, and Google's Files API does not take matroska.)
 */
const WATCHABLE_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mpeg: 'video/mpeg', mpg: 'video/mpeg', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac',
};

/** 'video' | 'audio' from the mime the extension resolved to, or null. */
function watchableFrom(name: string): { kind: 'video' | 'audio'; mediaType: string } | null {
  const mediaType = WATCHABLE_MIME_BY_EXT[(name.split('.').pop() ?? '').toLowerCase()];
  if (!mediaType) return null;
  return { kind: mediaType.startsWith('video/') ? 'video' : 'audio', mediaType };
}

/**
 * Resolve which attached file the model meant. No arg → the newest one. A name →
 * exact (filename or the `files/…` path the pointer line showed) first, then
 * substring, newest-wins — the model repeats what the note showed, it never
 * invents ids.
 */
function resolveMedia(media: MediaBlock[], wanted: string | undefined): MediaBlock | null {
  if (media.length === 0) return null;
  if (wanted === undefined || wanted.trim() === '') return media[media.length - 1];
  const needle = wanted.trim().toLowerCase();
  const newestFirst = [...media].reverse();
  const byExact = newestFirst.find(
    (m) => m.filename.toLowerCase() === needle || m.path.toLowerCase() === needle,
  );
  if (byExact) return byExact;
  return newestFirst.find((m) => m.filename.toLowerCase().includes(needle)) ?? null;
}

/**
 * The agent-made-file case: a `files/<name>` path with no block behind it (the
 * model cut a clip, exported a track). Built ad hoc — kind and mime from the
 * extension, size from stat. Contained to the workspace: the path is model
 * input and the bytes go to a third party, so anything resolving outside the
 * root is refused rather than uploaded.
 */
async function adHocMedia(workspaceDir: string, wanted: string): Promise<MediaBlock | null> {
  const root = resolve(workspaceDir);
  const abs = isAbsolute(wanted) ? resolve(wanted) : resolve(root, wanted);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const watchable = watchableFrom(abs);
  if (!watchable) return null;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    return {
      type: 'media',
      kind: watchable.kind,
      filename: basename(abs),
      path: rel.split(sep).join('/'),
      mediaType: watchable.mediaType,
      sizeBytes: st.size,
    };
  } catch {
    return null;
  }
}

export function makeWatchTool(deps: MediaWatchDeps): RawToolOptions {
  return {
    name: MEDIA_WATCH_TOOL_NAME,
    description:
      'Watch an attached video or listen to an attached audio file you cannot take in ' +
      'directly: a video-capable model watches it and answers your specific question — what ' +
      'happens, what is said, on-screen text, timestamps. Works on user uploads and on files ' +
      'in files/. Ask focused questions; call again for a different question or a different part.',
    parameters: z.object({
      question: z
        .string()
        .describe(
          'What you want to know about the video or audio. Specific beats general: "What does ' +
            'the speaker say about pricing?" gets a better answer than "describe this".',
        ),
      file: z
        .string()
        .optional()
        .describe(
          'Which file: its filename as shown in the attachment note, or a files/ path for a ' +
            'file you made. Omit to watch the most recently attached one.',
        ),
      start: z.number().optional().describe('Start of the part to watch, in seconds. Omit for the whole file.'),
      end: z.number().optional().describe('End of the part to watch, in seconds.'),
    }),
    // RESIDENT, not deferrable. The attachment pointer line NAMES this tool the
    // moment a video or audio file lands, so its schema has to be on the wire
    // already — a deferred tool is withheld by shapeToolSearchTools until the
    // model searches for it, and the model would be pointed at a tool it cannot
    // yet call. The schema is four small fields; residency costs almost nothing.
    deferrable: false,
    execute: async (args: unknown) => {
      const input = (args ?? {}) as { question?: unknown; file?: unknown; start?: unknown; end?: unknown };
      const question =
        typeof input.question === 'string' && input.question.trim() !== ''
          ? input.question.trim()
          : 'Describe what happens in this file.';
      const wanted = typeof input.file === 'string' && input.file.trim() !== '' ? input.file.trim() : undefined;
      const startSec = typeof input.start === 'number' && Number.isFinite(input.start) ? input.start : undefined;
      const endSec = typeof input.end === 'number' && Number.isFinite(input.end) ? input.end : undefined;

      // The per-turn cap, checked before anything else: no filesystem read, no
      // side call, and NO record (the cap is not a call that happened).
      if (deps.records.filter((r) => r.status !== 'skipped').length >= WATCH_CALLS_PER_TURN) {
        return (
          `You have watched ${WATCH_CALLS_PER_TURN} times this turn — answer from what you have, ` +
          'or ask the user to narrow the question.'
        );
      }

      const media = await deps.getMedia();
      const block =
        resolveMedia(media, wanted) ??
        (wanted !== undefined ? await adHocMedia(deps.workspaceDir, wanted) : null);
      if (block === null) {
        if (wanted === undefined) {
          return 'No video or audio is attached to this task yet — there is nothing to watch.';
        }
        const attached = media.length > 0 ? ` Attached (oldest→newest): ${media.map((m) => m.filename).join(', ')}.` : '';
        return (
          `No video or audio matches "${wanted}" — nothing attached has that name and no such ` +
          `video or audio file is under files/.${attached}`
        );
      }

      const { record, reason } = await runMediaWatch(deps, block, question, startSec, endSec);
      deps.records.push(record);
      if (record.status !== 'ok' || record.text === '') {
        return (
          `${block.kind === 'audio' ? 'Audio' : 'Video'} examination failed — ` +
          `${reason ?? 'the describe model did not return an answer'}. You can retry once, narrow ` +
          'to a clip with start/end, or process the file from files/ with the shell.'
        );
      }
      return `[Watched ${block.filename}]\n${record.text}`;
    },
  };
}

/**
 * The SHORT reason a strict media resolution threw, read as a typed field. The
 * engine may not import `transports/`, so the marker's error is recognised by the
 * shape it promises (`.reason`) rather than by a regex over `Error.message` — the
 * house rule for reading a failure. Anything else has no reason to report.
 */
function strictReason(err: unknown): string | undefined {
  const r = (err as { reason?: unknown } | null | undefined)?.reason;
  return typeof r === 'string' && r !== '' ? r : undefined;
}

/**
 * One bounded watch call: the question + the media block ride a fresh history on
 * the injected describe Transport. Mirrors runSuggestionCall's shape — a per-call
 * timeout OR the run's abort cancels it, and any failure degrades to an 'error'
 * record instead of throwing out of the tool. The block is COPIED before the
 * per-call options go on it: the journal's block is the file, not the watch.
 */
async function runMediaWatch(
  deps: MediaWatchDeps,
  block: MediaBlock,
  question: string,
  startSec: number | undefined,
  endSec: number | undefined,
): Promise<{ record: SideCallResult; reason?: string }> {
  const { transport, model, signal } = deps;
  if (signal?.aborted) {
    return { record: { text: '', status: 'skipped', model }, reason: 'the run was stopped' };
  }
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), WATCH_CALL_TIMEOUT_MS);
  try {
    // `low` resolution on VIDEO only — it is a frames-per-second knob, and Google
    // rejects it on audio. The cheap tier already reads on-screen text, and the
    // caller pays per frame. `strict` makes an unresolvable file THROW rather than
    // become a placeholder note: this request is nothing but the media, so a
    // placeholder buys a confident "I have no video" at full price.
    const forWire: MediaBlockForCall = {
      ...block,
      watchOptions: {
        ...(block.kind === 'video' && { resolution: 'low' }),
        ...(startSec !== undefined && { startSec }),
        ...(endSec !== undefined && { endSec }),
        strict: true,
      },
    };
    const history = transport.emptyHistory();
    transport.pushUser(history, question, [], [forWire]);
    const stream = transport.callModel({
      model,
      system: VIDEO_DESCRIBE_SYSTEM,
      tools: [],
      history,
      maxTokens: VIDEO_MAX_TOKENS,
      signal: ac.signal,
    });
    let text = '';
    let usage: NormalizedUsage | undefined;
    for await (const ev of transport.readStream(stream)) {
      if (ev.kind === 'text') text += ev.text;
      else if (ev.kind === 'done') usage = ev.usage;
    }
    return { record: { text: text.trim(), status: 'ok', ...(usage !== undefined && { usage }), model } };
  } catch (err) {
    return { record: { text: '', status: 'error', model }, ...(strictReason(err) && { reason: strictReason(err)! }) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A journal-backed live view of the task's WATCHABLE media, oldest→newest.
 *
 * `document` blocks are filtered OUT. `watch` sends the file to a describe model
 * as video or audio; the attachment pointer line already tells every lane a PDF
 * belongs to the Read tool, and an unfiltered view contradicted it twice — a
 * PDF-only task never reached the "nothing to watch" arm, and a PDF was the
 * default target of a bare `watch` call.
 */
function journalMedia(journal: JournalSnapshotSource | undefined): () => Promise<MediaBlock[]> {
  return async () => {
    if (!journal) return [];
    const out: MediaBlock[] = [];
    for (const e of await journal.snapshot()) {
      const p = e.payload as { blocks?: unknown };
      if (!Array.isArray(p.blocks)) continue;
      for (const b of p.blocks as { type?: string; kind?: string }[]) {
        if (b.type === 'media' && (b.kind === 'video' || b.kind === 'audio')) out.push(b as MediaBlock);
      }
    }
    return out;
  };
}

/** The one journal capability this module needs (kernel Journal satisfies it). */
export interface JournalSnapshotSource {
  snapshot(): Promise<readonly JournalEntry[]>;
}

/**
 * Register `watch` into a run's catalog — the ONE decision point (mirrors the
 * deferrable-ring's "one membership function" doctrine). Active only when ALL
 * hold: VIDEO_UNDERSTANDING_V1 is on, the run's model cannot take video in
 * natively, and the product injected a describe lane. Every inert path returns
 * the catalog BY REFERENCE, so the flag-off wire is byte-identical and
 * allocation-free. APPENDED at the end (before ToolSearch, which the prologue
 * adds after) so every resident tool keeps its catalog offset.
 */
export function attachMediaWatch(args: {
  model: string;
  catalog: RawToolOptions[];
  journal: JournalSnapshotSource | undefined;
  video: { transport: Transport; model: string } | undefined;
  records: SideCallResult[];
  signal?: AbortSignal;
  workspaceDir: string;
}): RawToolOptions[] {
  if (!videoUnderstandingEnabled()) return args.catalog;
  if (modelSupportsVideoInput(args.model)) return args.catalog;
  if (args.video === undefined) return args.catalog;
  return [
    ...args.catalog,
    makeWatchTool({
      getMedia: journalMedia(args.journal),
      transport: args.video.transport,
      model: args.video.model,
      records: args.records,
      workspaceDir: args.workspaceDir,
      ...(args.signal !== undefined && { signal: args.signal }),
    }),
  ];
}

/**
 * Fold a turn's watch records into ONE `vision` lane usage event (or undefined
 * when no call was made). Sums the successful calls' usage; a turn whose every
 * call failed reports zero tokens with laneStatus 'error' — the durable proof
 * calls were attempted, never a gap that reads as "never ran".
 */
export function mediaUsageEvent(
  records: readonly SideCallResult[],
  taskId: string,
  turnNumber: number,
): HarnessEvent | undefined {
  const attempted = records.filter((r) => r.status !== 'skipped');
  if (attempted.length === 0) return undefined;
  const ok = attempted.filter((r) => r.status === 'ok');
  const usage = ok.reduce<NormalizedUsage>(
    (acc, r) => ({
      inputTokens: acc.inputTokens + (r.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (r.usage?.outputTokens ?? 0),
      ...(acc.cacheReadInputTokens !== undefined || r.usage?.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: (acc.cacheReadInputTokens ?? 0) + (r.usage?.cacheReadInputTokens ?? 0) }
        : {}),
      ...(acc.cacheCreationInputTokens !== undefined || r.usage?.cacheCreationInputTokens !== undefined
        ? {
            cacheCreationInputTokens:
              (acc.cacheCreationInputTokens ?? 0) + (r.usage?.cacheCreationInputTokens ?? 0),
          }
        : {}),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  return laneUsageEvent(
    'vision',
    {
      status: ok.length > 0 ? 'ok' : 'error',
      ...(ok.length > 0 && { usage }),
      model: attempted[0].model,
    },
    taskId,
    turnNumber,
  );
}
