/**
 * Every JSON example in docs/guide that follows a `<!-- schema: Name -->` marker is checked against
 * that named schema, and every event, card and request/response body must have at least one checked
 * example. Run it while writing docs:  pnpm --filter @go/contract check-docs
 * The vitest suite runs the same check in CI.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as C from '../src/index.js';
import { Card } from '../src/cards.js';
import { Event } from '../src/events.js';
import { ROUTES } from '../src/routes.js';

export const GUIDE_DIR = fileURLToPath(new URL('../../../docs/guide/', import.meta.url));
const MARKER = /<!--\s*schema:\s*([A-Za-z]+)\s*-->\s*```json\n([\s\S]*?)```/g;

const idOf = (s: z.ZodType): string => z.globalRegistry.get(s)?.id ?? '';

export function requiredExamples(): Set<string> {
  const need = new Set<string>(['ErrorBody', 'SpendApprovalClaims']);
  for (const o of Event.options) need.add(idOf(o));
  for (const o of Card.options) need.add(idOf(o));
  for (const r of ROUTES) for (const s of [r.request, r.response]) if (s) need.add(idOf(s));
  need.delete('Event');
  need.delete('Card');
  need.delete('');
  return need;
}

export interface Problem { file: string; schema: string; message: string }

export function checkDocsExamples(dir: string = GUIDE_DIR): { checked: number; problems: Problem[]; missing: string[] } {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = readFileSync(`${dir}${file}`, 'utf8');
    for (const m of text.matchAll(MARKER)) {
      const [, name, json] = m as unknown as [string, string, string];
      checked++;
      const schema = (C as Record<string, unknown>)[name];
      if (!(schema instanceof z.ZodType)) { problems.push({ file, schema: name, message: 'no exported schema with this name' }); continue; }
      let value: unknown;
      try { value = JSON.parse(json); } catch (e) { problems.push({ file, schema: name, message: `not valid JSON: ${(e as Error).message}` }); continue; }
      const r = schema.safeParse(value);
      if (!r.success) { problems.push({ file, schema: name, message: z.prettifyError(r.error) }); continue; }
      seen.add(name);
      if (name === 'SpendApproved' || name === 'SpendDenied') seen.add('SpendApprovalResult');
      if (name === 'ActionDone' || name === 'ActionOpen' || name === 'ActionRefused') seen.add('CardActionResult');
    }
  }
  const missing = [...requiredExamples()].filter((n) => !seen.has(n)).sort();
  return { checked, problems, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { checked, problems, missing } = checkDocsExamples();
  for (const p of problems) console.log(`✗ ${p.file} ${p.schema}\n  ${p.message.replace(/\n/g, '\n  ')}`);
  if (missing.length) console.log(`Missing a checked example: ${missing.join(', ')}`);
  console.log(`${checked} examples checked, ${problems.length} wrong, ${missing.length} missing`);
  process.exit(problems.length || missing.length ? 1 : 0);
}
