/**
 * archive.ts — Phase 3 (§1.5) pure renderer for the compaction archive.
 *
 * Summarization archives the FULL pre-compaction span to a durable file
 * (`.kernel-archive/${taskId}/<thread>.md`, written by the engine-side
 * `archiveDroppedEntries`, see `../../engine/compaction-archive.ts`) so a
 * summary is never the only surviving record of what was dropped. This module
 * is the pure text-rendering half — no I/O, no clock, mirrors the purity
 * contract of compactor.ts / prune.ts.
 *
 * Best-effort fidelity, not a lossless replay format: the summary is the
 * load-bearing artifact for the model; this is the human/tool-readable audit
 * trail underneath it. Non-conversational entries (plan/mode/interaction/
 * usage/compact_boundary/…) carry no text and are skipped.
 */
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry } from '../../contract/journal.js';

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Render a dropped compaction span as a readable markdown transcript. */
export function renderArchiveMarkdown(entries: readonly JournalEntry[]): string {
  const sections: string[] = [];
  for (const e of entries) {
    const p = e.payload;
    switch (p.type) {
      case 'user':
        sections.push(`## User\n${textOf(p.blocks)}`);
        break;
      case 'assistant':
        sections.push(`## Assistant\n${textOf(p.blocks)}`);
        break;
      case 'tool_use':
        sections.push(`## Tool call: ${p.name}\n\`\`\`json\n${JSON.stringify(p.input, null, 2)}\n\`\`\``);
        break;
      case 'tool_result':
        sections.push(`## Tool result${p.isError ? ' (error)' : ''}\n${textOf(p.blocks)}`);
        break;
      default:
        break; // non-conversational state entries carry no archival text
    }
  }
  return sections.join('\n\n');
}
