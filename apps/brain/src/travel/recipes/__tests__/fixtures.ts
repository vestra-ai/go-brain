/** The saved ixigo.com responses and page text the recipe tests read, as a browser fetch would bring them back. */
import { readFileSync } from 'node:fs';
import type { Capture } from '../recipe.js';

export const fixture = (name: string): string => readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8');

/** A capture of one response: the fixture's body at the URL the page called. */
export const capture = (match: string, url: string, body: string, status = 200): Capture => ({
  match, url, status, content_type: 'application/json', body, truncated: false, at_ms: 1200,
});
