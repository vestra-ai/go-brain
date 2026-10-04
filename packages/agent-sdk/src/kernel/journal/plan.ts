import type { JournalEntry } from '../../contract/journal.js';
import type { TodoStatus } from '../../contract/blocks.js';

/** One todo, as folded from the journal's `plan` entries. */
export interface PlanTodo {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
  /**
   * §4.7 (the board) — the roster handle holding this item; absent when the
   * item is unheld. Never `null`: an `update` carrying `owner: null` unassigns
   * by DELETING the key, so an unheld item is shaped exactly as it was before
   * the board existed.
   */
  owner?: string;
}

/**
 * Phase 3 (§1.4) — pure fold of `plan` journal entries into the current todo list.
 *
 * PURITY CONTRACT (mirrors compactor.ts / prune.ts): no I/O, no clock, single
 * linear pass, never throws. An `update`/`delete` against an unknown id is
 * silently skipped (mirrors the pre-existing `stores` Map behavior in
 * apps/sandbox tools/task-tools.ts — a stray/duplicate mutation never crashes
 * the tool call).
 *
 * SCOPE: the caller passes an already-scoped entry list (e.g.
 * `projectScope(all, undefined)` for the main agent, or
 * `projectScope(all, childScope)` for a subagent) — this function does no
 * scoping itself, so quarantine (AC-P2) is a property of what the caller feeds
 * it, exactly like message projection.
 *
 * ORDER: todos are returned in first-`create` order (a later `update` never
 * reorders it), matching the historic Map insertion-order render.
 */
export function projectPlan(entries: readonly JournalEntry[]): PlanTodo[] {
  const order: string[] = [];
  const byId = new Map<string, PlanTodo>();

  for (const e of entries) {
    if (e.payload.type !== 'plan') continue;
    const p = e.payload;

    if (p.op === 'delete') {
      byId.delete(p.id);
      continue;
    }

    if (p.op === 'create') {
      byId.set(p.id, {
        id: p.id,
        content: p.content ?? '',
        status: p.status ?? 'pending',
        ...(p.activeForm !== undefined ? { activeForm: p.activeForm } : {}),
        // §4.7 — only a string assigns; `null`/absent leaves the item unheld
        // (no key), so a plan that never mentions ownership keeps today's shape.
        ...(typeof p.owner === 'string' ? { owner: p.owner } : {}),
      });
      order.push(p.id);
      continue;
    }

    // update
    const existing = byId.get(p.id);
    if (!existing) continue; // unknown id — skip, never throw.
    if (p.content !== undefined) existing.content = p.content;
    if (p.status !== undefined) existing.status = p.status;
    if (p.activeForm !== undefined) existing.activeForm = p.activeForm;
    // §4.7 — a string assigns/reassigns; an explicit `null` unassigns by
    // deleting the key; an omitted `owner` leaves the current holder alone.
    if (typeof p.owner === 'string') existing.owner = p.owner;
    else if (p.owner === null) delete existing.owner;
  }

  const seen = new Set<string>();
  const result: PlanTodo[] = [];
  for (const id of order) {
    if (seen.has(id)) continue; // dedupe re-create-of-same-id defensively
    seen.add(id);
    const t = byId.get(id);
    if (t) result.push(t); // absent ⇒ deleted — excluded
  }
  return result;
}
