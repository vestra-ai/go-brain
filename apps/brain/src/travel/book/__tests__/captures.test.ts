import { describe, expect, it } from 'vitest';
import type { CaptureSpec, FetchPlan } from '../../recipes/recipe.js';
import { bashCaptures, FETCH_TIMEOUT_MS, OPTIONAL_GRACE_MS, type BashCapture } from '../../recipes/runners.js';
import { loadBook } from '../book.js';
import type { RecipeFile } from '../format.js';

const { book } = loadBook();

/** Every capture list a recipe reads with: its own, and each fetch entry's (its own, or the recipe's). */
function plansOf(r: RecipeFile): Array<{ where: string; plan: FetchPlan }> {
  const lists = [{ where: r.id, capture: r.capture }, ...(r.fetch ?? []).map((f, i) => ({ where: `${r.id}, fetch ${i + 1}`, capture: f.capture ?? r.capture }))];
  return lists.filter((l) => (l.capture?.length ?? 0) > 0).map((l) => ({ where: l.where, plan: { capture: l.capture as CaptureSpec[] } }));
}

const optional = book.all().flatMap(plansOf).filter(({ plan }) => plan.capture.some((c) => !c.required));

/**
 * Bash's browser fetch as its contract says (recipe.ts FetchPlan): it answers once every capture it waits for is in, or
 * at the timeout. Without a grace it waits for every capture not marked `required: false`; with one, for the required
 * ones, and then at most the grace for the rest. `arrives` is when a capture's call comes, or null for never.
 */
function answersAt(body: { capture: BashCapture[]; grace_ms?: number }, arrives: (c: BashCapture) => number | null): number {
  const at = (c: BashCapture): number => arrives(c) ?? Number.POSITIVE_INFINITY;
  const waited = Math.max(0, ...body.capture.filter((c) => c.required !== false).map(at));
  if (waited >= FETCH_TIMEOUT_MS) return FETCH_TIMEOUT_MS;
  if (!body.grace_ms) return waited;
  const rest = Math.max(waited, ...body.capture.filter((c) => c.required === false).map(at));
  return Math.min(rest, waited + body.grace_ms, FETCH_TIMEOUT_MS);
}

// Staging, 10 Oct: hotels.details p50 23.7 s, trains.between and the plain offers read about 20 s. A recipe's
// `required: false` reached Bash only with a grace, so Bash waited for an optional call the page never made.
describe("the book's captures, as Bash is asked for them", () => {
  it('no capture a recipe sets is silently ignored: every field reaches Bash, an optional one as not required', () => {
    const plans = book.all().flatMap(plansOf);
    expect(plans.length).toBeGreaterThan(20);
    for (const { where, plan } of plans) {
      const body = bashCaptures(plan);
      plan.capture.forEach((c, i) => {
        const sent = body.capture[i]!;
        expect(sent.match, where).toBe(c.match);
        if (!c.required) {
          expect(sent.required, `${where}: ${c.match}`).toBe(false);
          expect(body.grace_ms, `${where}: ${c.match}`).toBe(OPTIONAL_GRACE_MS);
        }
        for (const k of ['min_count', 'max_count', 'max_bytes', 'sse'] as const) expect(sent[k], `${where}: ${c.match} ${k}`).toBe(c[k]);
      });
    }
  });

  it('every capture list keeps one required capture, so an optional one can take the grace (Bash refuses a fetch with none)', () => {
    for (const { where, plan } of book.all().flatMap(plansOf)) expect(plan.capture.some((c) => c.required), where).toBe(true);
  });

  it('the recipes with an optional capture are the ones staging found slow, and each answers within the grace of its required ones', () => {
    expect([...new Set(optional.map((o) => o.where.split(',')[0]))].sort()).toEqual(['flights.round_trip', 'hotels.details', 'offers.list', 'trains.between']);
    for (const { where, plan } of optional) {
      const body = bashCaptures(plan);
      const required = (c: BashCapture): boolean => c.required !== false;
      // The required calls come at 2 s; the optional ones never: answered by 3.5 s, never the 20 s timeout.
      expect(answersAt(body, (c) => (required(c) ? 2_000 : null)), where).toBe(2_000 + OPTIONAL_GRACE_MS);
      // An optional call inside the grace is kept, and answered as soon as it comes.
      expect(answersAt(body, (c) => (required(c) ? 2_000 : 2_600)), where).toBe(2_600);
      // As Bash was asked before (no grace, no required): the optional call that never comes held it to the timeout.
      const before = { capture: plan.capture.map((c) => ({ match: c.match })) };
      expect(answersAt(before, (c) => (plan.capture.find((x) => x.match === c.match)!.required ? 2_000 : null)), where).toBe(FETCH_TIMEOUT_MS);
    }
  });
});
