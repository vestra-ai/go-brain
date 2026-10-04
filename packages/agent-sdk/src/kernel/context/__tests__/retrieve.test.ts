import { describe, it, expect } from 'vitest';
import { tokenize, retrieve, chunkMemory, type MemoryChunk } from '../retrieve.js';

const corpus: MemoryChunk[] = [
  { id: '1', text: 'The user lives in Bangalore India.' },
  { id: '2', text: 'The user prefers dark mode.' },
  { id: '3', text: 'The capital of France is Paris.' },
];

describe('retrieve', () => {
  it('tokenizes lowercase alphanumeric words', () => {
    expect(tokenize('Hello, World-2!')).toEqual(['hello', 'world', '2']);
  });

  it('ranks the answer-bearing chunk first', () => {
    const r = retrieve({ corpus, query: 'where in India does the user live', k: 2 });
    expect(r.abstained).toBe(false);
    expect(r.chunks[0].chunk.id).toBe('1');
  });

  it('abstains when no query term matches the corpus', () => {
    const r = retrieve({ corpus, query: 'quantum chromodynamics lagrangian', k: 3 });
    expect(r.abstained).toBe(true);
    expect(r.chunks).toEqual([]);
  });

  it('chunkMemory splits non-empty trimmed lines', () => {
    expect(chunkMemory('a\n\n  b  \n')).toEqual([
      { id: '0', text: 'a' },
      { id: '1', text: 'b' },
    ]);
  });
});
