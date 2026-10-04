import { describe, it, expect } from 'vitest';
import { WIKI_CATEGORIES, validateEditorOps, type EditorPassPlan } from '../wiki-editor-ops.js';

const existing = ['keshav-musunuri', 'vestra-org'];

describe('validateEditorOps', () => {
  it('fixed taxonomy is exactly the seven categories', () => {
    expect(WIKI_CATEGORIES).toEqual([
      'person', 'organization', 'project', 'preference', 'decision', 'topic', 'routine',
    ]);
  });

  it('accepts create/rewrite/merge/delete with well-formed fields', () => {
    const plan: EditorPassPlan = {
      ops: [
        { kind: 'create', slug: 'musicians-cart', title: 'Musicians Cart', category: 'organization', body: 'A guitar retailer [s1].\n\n## Sources\n[s1]: episode ep_1' },
        { kind: 'rewrite', slug: 'keshav-musunuri', title: 'Keshav Musunuri', category: 'person', body: 'Updated article [s1].\n\n## Sources\n[s1]: episode ep_2' },
        { kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' },
        { kind: 'delete', slug: 'vestra-org' },
      ],
    };
    const { valid, rejected } = validateEditorOps(plan, existing);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(4);
  });

  it('rejects: unknown category, rewrite of a nonexistent slug, delete of a nonexistent slug, body without citation, slug escaping the wiki (path traversal), duplicate ops on one slug', () => {
    const plan: EditorPassPlan = {
      ops: [
        { kind: 'create', slug: 'x', title: 'X', category: 'vibes' as never, body: 'b [s1]' },
        { kind: 'rewrite', slug: 'ghost', title: 'G', category: 'topic', body: 'b [s1]' },
        { kind: 'delete', slug: 'ghost' },
        { kind: 'create', slug: 'no-cite', title: 'N', category: 'topic', body: 'no citations here' },
        { kind: 'create', slug: '../escape', title: 'E', category: 'topic', body: 'b [s1]' },
        { kind: 'rewrite', slug: 'keshav-musunuri', title: 'A', category: 'person', body: 'a [s1]' },
        { kind: 'delete', slug: 'keshav-musunuri' },
      ],
    };
    const { valid, rejected } = validateEditorOps(plan, existing);
    expect(valid).toHaveLength(1); // only the first keshav-musunuri op survives
    expect(rejected).toHaveLength(6);
  });

  it('rejects a second merge retiring the same source slug', () => {
    const existingLocal = ['keshav-musunuri', 'vestra-org', 'musicians-cart'];
    const plan: EditorPassPlan = {
      ops: [
        { kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' },
        { kind: 'merge', into: 'musicians-cart', from: 'vestra-org' },
      ],
    };
    const { valid, rejected } = validateEditorOps(plan, existingLocal);
    expect(valid).toEqual([{ kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' }]);
    expect(rejected).toEqual([
      { op: { kind: 'merge', into: 'musicians-cart', from: 'vestra-org' }, reason: 'duplicate merge from vestra-org' },
    ]);
  });

  it('rejects a rewrite of a slug already being retired by an earlier merge', () => {
    const plan: EditorPassPlan = {
      ops: [
        { kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' },
        { kind: 'rewrite', slug: 'vestra-org', title: 'V', category: 'organization', body: 'b [s1]' },
      ],
    };
    const { valid, rejected } = validateEditorOps(plan, existing);
    expect(valid).toEqual([{ kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' }]);
    expect(rejected).toEqual([
      {
        op: { kind: 'rewrite', slug: 'vestra-org', title: 'V', category: 'organization', body: 'b [s1]' },
        reason: 'slug vestra-org is being retired by a merge',
      },
    ]);
  });

  it('rejects a merge retiring a slug already written earlier in the plan (reverse order)', () => {
    const plan: EditorPassPlan = {
      ops: [
        { kind: 'rewrite', slug: 'vestra-org', title: 'V', category: 'organization', body: 'b [s1]' },
        { kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' },
      ],
    };
    const { valid, rejected } = validateEditorOps(plan, existing);
    expect(valid).toEqual([
      { kind: 'rewrite', slug: 'vestra-org', title: 'V', category: 'organization', body: 'b [s1]' },
    ]);
    expect(rejected).toEqual([
      {
        op: { kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' },
        reason: 'slug vestra-org is being retired by a merge',
      },
    ]);
  });

  it('rejects any op whose kind is outside the closed vocabulary (unknown kind), including a malformed {} op', () => {
    const plan = {
      ops: [
        // A bogus kind carrying otherwise-plausible fields must not slip through.
        { kind: 'transmogrify', slug: 'keshav-musunuri', title: 'K', category: 'person', body: 'b [s1]' },
        // A fully malformed op ({}) must be rejected too, not silently validated.
        {},
      ],
    } as unknown as EditorPassPlan;
    const { valid, rejected } = validateEditorOps(plan, existing);
    expect(valid).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toBe('unknown kind');
    expect(rejected[1].reason).toBe('unknown kind');
  });

  it('rejects a nested slug like a/b (pages are a flat directory)', () => {
    const plan: EditorPassPlan = {
      ops: [{ kind: 'create', slug: 'a/b', title: 'AB', category: 'topic', body: 'b [s1]' }],
    };
    const { valid, rejected } = validateEditorOps(plan, existing);
    expect(valid).toEqual([]);
    expect(rejected).toEqual([{ op: plan.ops[0], reason: 'bad slug: a/b' }]);
  });

  it('allows two merges into the same canonical page', () => {
    const existingLocal = ['keshav-musunuri', 'vestra-org', 'musicians-cart'];
    const plan: EditorPassPlan = {
      ops: [
        { kind: 'merge', into: 'keshav-musunuri', from: 'vestra-org' },
        { kind: 'merge', into: 'keshav-musunuri', from: 'musicians-cart' },
      ],
    };
    const { valid, rejected } = validateEditorOps(plan, existingLocal);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(2);
  });
});
