/**
 * Recipe templates: "/buses/bus_search/{from.name}/{from.id}/{to.name}/{to.id}/{date|DD-MM-YYYY}/O". Each {…} is a JSONata
 * expression over the inputs, optionally followed by "|" and a date form. In an address every value is URL-encoded, so a
 * place's name can never add a parameter; a value already in the page's own form (a filters list) says "|raw".
 */
import { dateAs, DATE_FORMS, evaluate, type DateForm } from './expr.js';

const PART = /\{([^{}]+)\}/g;
const FORMS = new Set<string>([...DATE_FORMS, 'raw']);

/** The parts of a template, for the loader's check: each expression and its form. */
export function partsOf(template: string): Array<{ source: string; form: string | null }> {
  return [...template.matchAll(PART)].map((m) => {
    const bar = m[1]!.lastIndexOf('|');
    const form = bar >= 0 ? m[1]!.slice(bar + 1).trim() : null;
    return form !== null && FORMS.has(form) ? { source: m[1]!.slice(0, bar).trim(), form } : { source: m[1]!.trim(), form: null };
  });
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === false) return '';
  if (Array.isArray(value)) return value.map(show).join(',');
  return String(value);
}

/** Fills a template from the inputs. An address (url: true) has every value URL-encoded unless it says "|raw". */
export async function fill(template: string, inputs: Record<string, unknown>, o: { url: boolean; bindings?: Record<string, unknown> }): Promise<string> {
  const parts = partsOf(template);
  const values: string[] = [];
  for (const p of parts) {
    let v = await evaluate(p.source, inputs, { inputs, ...o.bindings });
    if (p.form && p.form !== 'raw') v = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dateAs(v, p.form as DateForm) : undefined;
    const text = show(v);
    values.push(o.url && p.form !== 'raw' ? encodeURIComponent(text) : text);
  }
  let i = 0;
  return template.replace(PART, () => values[i++] ?? '');
}
