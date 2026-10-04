/**
 * VolumeContextPort — the K4 concrete file-reading `ContextPort` impl.
 *
 * Lives in the engine (batteries) layer, NOT the pure root: it imports `node:fs`
 * (`readFileSync`), so keeping it out of the root-reachable kernel barrel is what
 * lets a browser bundle of `@vestra/agent-sdk` / `@bash/shared` stay free of Node
 * built-ins (the ring-E node:fs-in-root fix). Exported from `@vestra/agent-sdk/engine`.
 *
 * Reads the user's memory, trims, and wraps it in the `<user_memory>` data fence.
 * Prefers the Keeper profile (`<workingDir>/memory/user.md` — the folded, curated
 * memory the Keeper materializes onto every placement) and falls back to the legacy
 * `<workingDir>/memory/MEMORY.md` (the pre-Keeper writer) when the profile is absent
 * or empty, so a sandbox that has no user.md yet stays byte-identical to before.
 * Returns '' on ANY error (missing file — the common/fresh-sandbox case; a directory
 * at the path; unreadable) — NEVER throws.
 * `onPreCompact` is a NO-OP in K4: it MUST NOT write `memory/` (the
 * three-write-paths race — server-side extraction stays the only FS writer).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry } from '../../contract/journal.js';
import type { ContextPort, ContextQuery } from './context-port.js';

/** The fence makes recalled memory DATA, not instructions. Empty/whitespace
 *  content → '' (nothing to recall). Exported so RetrievalContextPort wraps its
 *  top-k output in the exact same fence (the conformance suite asserts the shape). */
export function fenceUserMemory(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `<user_memory>\n${trimmed}\n</user_memory>`;
}

/** Pulse V1 RAM tier — the server-rendered situation.md is fenced as DATA (like
 *  user_memory). Empty/whitespace content → '' (nothing to inject). Sibling of
 *  `fenceUserMemory`; the native/openai builders push it as the `situation` layer. */
export function fenceSituation(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `<situation>\n${trimmed}\n</situation>`;
}

export class VolumeContextPort implements ContextPort {
  constructor(private readonly workingDir: string) {}

  async readSnapshot(_query: ContextQuery): Promise<string> {
    // Prefer the Keeper profile (user.md); a non-empty read wins. An absent or
    // empty profile — the pre-Keeper / fresh-sandbox case — falls back to the
    // legacy MEMORY.md so behaviour is unchanged where no user.md exists.
    const profile = this.readMemoryFile(join(this.workingDir, 'memory', 'user.md'));
    if (profile.trim()) return fenceUserMemory(profile);
    return fenceUserMemory(this.readMemoryFile(join(this.workingDir, 'memory', 'MEMORY.md')));
  }

  /** Read a memory file, or '' on ANY error (missing/dir/unreadable) — NEVER throws. */
  private readMemoryFile(path: string): string {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // Missing file (fresh sandbox), a directory at the path, unreadable — all
      // degrade to no-recall. NEVER throw into the turn.
      return '';
    }
  }

  /**
   * Read the server-rendered `<workingDir>/memory/situation.md` (the "what your other
   * sessions and scheduled tasks did recently" feed), trim, and wrap it in the
   * `<situation>` data fence. Returns '' on ANY error (missing file — the common case;
   * a directory at the path; unreadable) or empty content — NEVER throws. Mirrors
   * `readSnapshot`.
   *
   * NO CALLER IN PRODUCTION since Nami Phase 2 task E5 retired the Pulse push: the
   * run-driver no longer builds a `situation` prompt layer, and nothing reads the file
   * back either — no arm opens it, and the live reader of this content is the web
   * Memory dossier, which asks the server for it over the API rather than reading the
   * volume. The materialize pull lane still WRITES situation.md, so the file exists
   * with no consumer; Phase 3 decides its fate. Kept as a port method, not deleted,
   * because the file and its fence are unchanged — what went is the injection.
   */
  async readSituation(): Promise<string> {
    try {
      const situationPath = join(this.workingDir, 'memory', 'situation.md');
      const raw = readFileSync(situationPath, 'utf8');
      return fenceSituation(raw);
    } catch {
      // Missing file (flag-off / fresh sandbox), a directory at the path,
      // unreadable — all degrade to no-injection. NEVER throw into the turn.
      return '';
    }
  }

  async onPreCompact(_slice: { dropped: JournalEntry[]; summaryText: string }): Promise<void> {
    // K4 no-op: the write-curator is P-Nami. Do NOT write memory/ here — the
    // server owns the memory/ FS surface (the Nami keeper materializes it).
  }
}
