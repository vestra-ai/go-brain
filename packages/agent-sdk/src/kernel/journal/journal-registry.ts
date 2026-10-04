/**
 * journal-registry.ts — ONE LIVE JOURNAL PER FILE IN A PROCESS (JOURNAL_ONE_WRITER_V1).
 *
 * The runner keeps a task's Journal on its actor, and an actor can be disposed while the run it
 * drove is still unwinding: forceCleanup interrupts the run without waiting (query-manager.ts) and
 * drops the actor at once, so the interrupted run's last writes (its abort seal, usage, a helper's
 * scoped entries) still land through the OLD Journal. R5 (#4157) made the task's next Journal wait
 * for the old one's tail AS IT WAS at disposal; writes after that moment still ran on a second
 * tail chain beside the new Journal's, and two chains over one file is the fork: duplicate seqs,
 * two children of one parent.
 *
 * So there is no second Journal while the first can still write. `open` hands out the live
 * instance for the file (every actor of the task shares it, and so does whatever still holds the
 * old one); `release` only schedules the drop, which happens once the journal has settled and
 * nobody re-opened it for `drainMs`. The drop releases the cross-process writer lock
 * (writer-lock.ts), and a write that still arrives through the dropped instance is refused by it
 * (JournalFencedError), never written beside the next instance's.
 */
import type { JournalWriteGuard } from './writer-lock.js';

/** What the registry needs of a journal: when its queued appends have landed. */
export interface RegisteredJournal {
  settled(): Promise<void>;
}

interface Live<J> {
  journal: J;
  guard: JournalWriteGuard;
  refs: number;
  drop: ReturnType<typeof setTimeout> | undefined;
}

export interface JournalRegistryOptions {
  /** The cross-process writer guard for one journal file. */
  makeGuard: (path: string) => JournalWriteGuard;
  /** How long a released journal stays live (re-openable as the same instance) before it is dropped. */
  drainMs?: number;
}

export class JournalRegistry<J extends RegisteredJournal> {
  private readonly live = new Map<string, Live<J>>();

  constructor(private readonly opts: JournalRegistryOptions) {}

  /** The one live journal for `path`: the existing instance, or a new one built with its guard. */
  open(path: string, make: (guard: JournalWriteGuard) => J): J {
    const held = this.live.get(path);
    if (held) {
      held.refs += 1;
      if (held.drop) clearTimeout(held.drop);
      held.drop = undefined;
      return held.journal;
    }
    const guard = this.opts.makeGuard(path);
    const journal = make(guard);
    this.live.set(path, { journal, guard, refs: 1, drop: undefined });
    return journal;
  }

  /** The owner is done with it. The instance stays live (and the same) until it settles and drains. */
  release(path: string, journal: J): void {
    const held = this.live.get(path);
    if (!held || held.journal !== journal) return;
    held.refs = Math.max(0, held.refs - 1);
    if (held.refs > 0 || held.drop) return;
    held.drop = setTimeout(() => {
      held.drop = undefined;
      void journal.settled().then(() => this.dropIfIdle(path, held));
    }, this.opts.drainMs ?? 60_000);
    held.drop.unref?.();
  }

  /** Is a journal for `path` live in this process (test and diagnostics)? */
  has(path: string): boolean {
    return this.live.has(path);
  }

  /** Drop every journal now and release every lock (process shutdown, tests). */
  async closeAll(): Promise<void> {
    const all = [...this.live.values()];
    this.live.clear();
    for (const held of all) {
      if (held.drop) clearTimeout(held.drop);
      await held.journal.settled().catch(() => {});
      await held.guard.release().catch(() => {});
    }
  }

  private async dropIfIdle(path: string, held: Live<J>): Promise<void> {
    if (this.live.get(path) !== held || held.refs > 0 || held.drop) return;
    this.live.delete(path);
    await held.guard.release().catch(() => {});
  }
}
