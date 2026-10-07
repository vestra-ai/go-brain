/**
 * The recipe book: every file in apps/brain/recipes/<section>/<name>.yaml, checked when Go starts. A file is checked
 * against the format, its id against its path ("buses/between.yaml" is buses.between), every expression and template
 * part compiled, and every lookup it names found. A file that fails is left out with the reason; the rest run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { expr } from './expr.js';
import { RecipeFile } from './format.js';
import { partsOf } from './template.js';

/** apps/brain/recipes, from src/travel/book or dist/travel/book alike. */
export const BOOK_DIR = fileURLToPath(new URL('../../../recipes/', import.meta.url));

export interface Book {
  get(id: string): RecipeFile | undefined;
  all(): RecipeFile[];
}

/** Every expression a recipe carries, with where it is, for the compile check. */
function expressionsOf(r: RecipeFile): Array<[where: string, source: string]> {
  const out: Array<[string, string]> = [];
  const templates: Array<[string, string]> = [];
  for (const [name, input] of Object.entries(r.inputs)) if (input.value) out.push([`inputs.${name}.value`, input.value]);
  for (const [name, c] of Object.entries(r.conditions ?? {})) out.push([`conditions.${name}`, c]);
  for (const [name, l] of Object.entries(r.let ?? {})) out.push([`let.${name}`, l]);
  for (const [i, f] of (r.fetch ?? []).entries()) out.push([`fetch.${i}.when`, f.when]);
  if (r.read) {
    out.push(['read.rows.list', r.read.rows.list]);
    if (r.read.rows.unique) out.push(['read.rows.unique', r.read.rows.unique]);
    for (const [name, a] of Object.entries(r.read.also ?? {})) out.push([`read.also.${name}`, a.value]);
  }
  const a = r.answer;
  if (a.as === 'options') {
    out.push(['answer.each', a.each]);
    if (a.keep) out.push(['answer.keep', a.keep]);
  } else if (a.as === 'facts') {
    out.push(['answer.each', a.each]);
    templates.push(['answer.title', a.title]);
  } else if (a.as === 'link') {
    templates.push(['answer.title', a.title]);
    if (a.who) out.push(['answer.who', a.who]);
  } else {
    for (const [k, v] of Object.entries(a.suggestions)) if (k !== 'words_param' && typeof v === 'string') out.push([`answer.suggestions.${k}`, v]);
  }
  if (r.page) templates.push(['page', r.page]);
  if (r.fast) {
    templates.push(['fast.url', r.fast.url]);
    if (r.fast.body) templates.push(['fast.body', r.fast.body]);
  }
  for (const [i, c] of [...(r.capture ?? []), ...(r.fetch ?? []).flatMap((f) => f.capture ?? [])].entries()) templates.push([`capture.${i}`, c.match]);
  if (r.read) {
    templates.push(['read.rows.from', r.read.rows.from]);
    for (const [name, a] of Object.entries(r.read.also ?? {})) templates.push([`read.also.${name}.from`, a.from]);
  }
  for (const [i, f] of (r.fetch ?? []).entries()) {
    for (const [j, s] of (f.steps ?? []).entries()) {
      if ('text' in s && s.text) templates.push([`fetch.${i}.steps.${j}.text`, s.text]);
      if ('name' in s && s.name) templates.push([`fetch.${i}.steps.${j}.name`, s.name]);
    }
  }
  for (const [end, steps] of Object.entries(r.box?.type ?? {})) {
    for (const [i, s] of steps.entries()) if ('text' in s && s.text) templates.push([`box.type.${end}.${i}`, s.text]);
  }
  for (const [where, t] of templates) for (const p of partsOf(t)) out.push([where, p.source]);
  return out;
}

/** Checks one file; the problems, or the recipe. */
export function checkRecipe(path: string, text: string): { recipe: RecipeFile } | { problems: string[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    return { problems: [`${path}: not YAML (${err instanceof Error ? err.message.split('\n')[0] : 'unreadable'})`] };
  }
  const r = RecipeFile.safeParse(raw);
  if (!r.success) return { problems: r.error.issues.map((i) => `${path}: ${i.path.join('.') || 'file'}: ${i.message}`) };
  const problems: string[] = [];
  const want = path.replace(/\\/g, '/').replace(/\.ya?ml$/, '').split('/').slice(-2).join('.');
  if (r.data.id !== want) problems.push(`${path}: id is ${r.data.id}, but its path says ${want}`);
  for (const [where, source] of expressionsOf(r.data)) {
    try {
      expr(source);
    } catch (err) {
      problems.push(`${path}: ${where}: ${err instanceof Error ? err.message : 'does not compile'}`);
    }
  }
  return problems.length ? { problems } : { recipe: r.data };
}

/** Loads the book; a recipe whose lookup is missing is left out too. */
export function loadBook(dir: string = BOOK_DIR): { book: Book; problems: string[] } {
  const problems: string[] = [];
  const recipes = new Map<string, RecipeFile>();
  const sections = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'samples');
  for (const section of sections) {
    for (const file of readdirSync(join(dir, section.name)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const path = join(section.name, file);
      const checked = checkRecipe(path, readFileSync(join(dir, path), 'utf8'));
      if ('problems' in checked) problems.push(...checked.problems);
      else if (recipes.has(checked.recipe.id)) problems.push(`${path}: ${checked.recipe.id} is in the book twice`);
      else recipes.set(checked.recipe.id, checked.recipe);
    }
  }
  for (const r of [...recipes.values()]) {
    for (const [name, input] of Object.entries(r.inputs)) {
      const lookup = input.lookup ? recipes.get(input.lookup) : undefined;
      if (input.lookup && lookup?.answer.as !== 'places') {
        problems.push(`${r.id}: input ${name} names the lookup ${input.lookup}, which is not in the book`);
        recipes.delete(r.id);
      }
    }
  }
  const book: Book = { get: (id) => recipes.get(id), all: () => [...recipes.values()] };
  return { book, problems };
}
