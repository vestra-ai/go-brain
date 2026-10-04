import { describe, it, expect } from 'vitest';
import { resolveWikiSlug } from '../wiki-entity-resolve.js';

const existing = ['keshav-musunuri', 'musicians-cart', 'vestra-org', 'ng'];

describe('resolveWikiSlug', () => {
  it('normalized exact match wins regardless of case/spacing/punctuation', () => {
    expect(resolveWikiSlug('Keshav  Musunuri', existing)).toEqual({ slug: 'keshav-musunuri', matched: true });
    expect(resolveWikiSlug('KESHAV-MUSUNURI', existing)).toEqual({ slug: 'keshav-musunuri', matched: true });
  });

  it('fuzzy match catches decorated variants of an existing entity', () => {
    expect(resolveWikiSlug('Keshav Musunuri (user)', existing)).toEqual({ slug: 'keshav-musunuri', matched: true });
    expect(resolveWikiSlug("user Keshav Musunuri's role", existing)).toEqual({ slug: 'keshav-musunuri', matched: true });
  });

  it('short/low-entropy names never fuzzy-match (entropy gate)', () => {
    expect(resolveWikiSlug('nk', existing)).toEqual({ slug: 'nk', matched: false });
    expect(resolveWikiSlug('n g', existing).matched).toBe(false);
  });

  it('genuinely new entities come back unmatched, slugified', () => {
    expect(resolveWikiSlug('Granola Meetings', existing)).toEqual({ slug: 'granola-meetings', matched: false });
  });
});
