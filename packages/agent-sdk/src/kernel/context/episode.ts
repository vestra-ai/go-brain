// nami brain v2 — the CaptureEpisode: a finished task rendered as ordered journal
// blocks, the full-fidelity input the capture judge sees (vs the old flat
// transcript string). Named distinctly from the legacy persisted skill-log
// `Episode` in skills.ts, which is a different shape that survives into the dream.

import type { SalienceVector } from './salience.js';

export type JournalBlockKind = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'interaction';

export interface JournalBlock {
  kind: JournalBlockKind;
  text: string;
  /** Set on a tool_result whose tool failed. Surfaced to the judge as a surprise cue. */
  isError?: boolean;
  /** ISO timestamp of the block, when known. */
  at?: string;
}

export interface CaptureEpisode {
  taskId: string;
  /** ISO timestamp the episode was observed (closed). */
  observedAt: string;
  blocks: JournalBlock[];
  /** §3a prefilter signal, attached once computed. */
  salience?: SalienceVector;
}

const KINDS: JournalBlockKind[] = ['user', 'assistant', 'tool_use', 'tool_result', 'interaction'];
const ROLE_PREFIX = new RegExp(`^(${KINDS.join('|')}):\\s?`);

/**
 * Back-compat shim for the flat `role: text` transcript the eval seed items still
 * use. A line beginning with a known kind (`user:`, `assistant:`, ...) starts a new
 * block; following lines append to it. Leading text before any role marker is
 * dropped (the seeds always open with a role). Block text is trimmed.
 */
export function transcriptToBlocks(transcript: string): JournalBlock[] {
  const blocks: JournalBlock[] = [];
  let current: JournalBlock | null = null;
  const flush = () => {
    if (current) {
      current.text = current.text.trim();
      blocks.push(current);
    }
  };
  for (const line of transcript.split('\n')) {
    const m = line.match(ROLE_PREFIX);
    if (m) {
      flush();
      current = { kind: m[1] as JournalBlockKind, text: line.slice(m[0].length) };
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  flush();
  return blocks;
}

/**
 * Causal, labeled rendering for the judge prompt: `now: <observedAt>` followed by
 * each block on its own line as `[<kind>[ error]] <text>`, in order.
 */
export function serializeEpisode(ep: CaptureEpisode): string {
  const body = ep.blocks
    .map((b) => `\n[${b.kind}${b.isError ? ' error' : ''}] ${b.text}`)
    .join('');
  return `now: ${ep.observedAt}${body}`;
}
