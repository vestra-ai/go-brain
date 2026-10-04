import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry } from '../../contract/journal.js';
import type { ContextPort, ContextQuery } from './context-port.js';
import { fenceUserMemory } from './volume-context-port.js';
import { retrieve, chunkMemory } from './retrieve.js';

export interface RetrievalContextOptions {
  /** max chunks to surface for a query (default 5) */
  k?: number;
  /** abstention floor; below this top score the port returns '' (default 0) */
  floor?: number;
}

/**
 * Query-scoped ContextPort: reads the memory profile (memory/user.md, falling back
 * to a legacy memory/MEMORY.md — same precedence as VolumeContextPort) and, when
 * given a query, returns only the BM25-lite top-k chunks (fenced) instead of the whole file.
 * Imports node:fs, so it lives in the engine batteries layer, never the pure root.
 *
 * Behavior:
 *  - no query (session-open push)  -> whole file fenced (parity with VolumeContextPort)
 *  - query, matches               -> top-k chunks fenced
 *  - query, no match (abstain)    -> '' (degrade-safe, same as NoopContextPort)
 *  - any error (missing file ...) -> '' (never throws into the turn)
 */
export class RetrievalContextPort implements ContextPort {
  constructor(
    private readonly workingDir: string,
    private readonly opts: RetrievalContextOptions = {},
  ) {}

  async readSnapshot(query: ContextQuery): Promise<string> {
    try {
      // user.md is the file of truth; MEMORY.md is read only as the pre-collapse
      // legacy fallback (a volume whose profile never folded).
      let raw = '';
      try {
        raw = readFileSync(join(this.workingDir, 'memory', 'user.md'), 'utf8');
      } catch {
        /* absent — fall through to legacy */
      }
      if (raw.trim() === '') {
        raw = readFileSync(join(this.workingDir, 'memory', 'MEMORY.md'), 'utf8');
      }
      if (!query.query) return fenceUserMemory(raw);
      const res = retrieve({
        corpus: chunkMemory(raw),
        query: query.query,
        k: this.opts.k ?? 5,
        floor: this.opts.floor ?? 0,
      });
      if (res.abstained) return '';
      return fenceUserMemory(res.chunks.map((c) => c.chunk.text).join('\n'));
    } catch {
      return '';
    }
  }

  async onPreCompact(_slice: { dropped: JournalEntry[]; summaryText: string }): Promise<void> {
    // K4 no-op: the write-curator (P-Nami) is deferred. Same as VolumeContextPort.
  }
}
