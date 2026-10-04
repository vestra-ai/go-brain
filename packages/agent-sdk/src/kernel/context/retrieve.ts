// nami v0 retrieval engine: BM25-lite keyword ranking with an abstention floor.
// Pure + dependency-free (no node:fs) so it is safe to import anywhere.
// Twin: scripts/nami-memory-eval/src/retrieve.ts (the eval scores this exact logic).

export interface MemoryChunk {
  id: string;
  text: string;
}

export interface ScoredChunk {
  chunk: MemoryChunk;
  score: number;
}

export interface RetrievalResult {
  chunks: ScoredChunk[];
  abstained: boolean;
}

export interface RetrieveOptions {
  corpus: MemoryChunk[];
  query: string;
  /** max chunks to return (default 5) */
  k?: number;
  /** min top score to NOT abstain (default 0 — abstain only when nothing matches) */
  floor?: number;
}

export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** BM25-lite keyword retrieval with abstention. Returns top-k chunks, or abstains. */
export function retrieve(opts: RetrieveOptions): RetrievalResult {
  const k = opts.k ?? 5;
  const floor = opts.floor ?? 0;
  const qTerms = tokenize(opts.query);
  const N = opts.corpus.length || 1;

  const docTokens = opts.corpus.map((c) => tokenize(c.text));
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    for (const w of new Set(toks)) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const idf = (term: string): number => Math.log(1 + N / (1 + (df.get(term) ?? 0)));
  const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;

  const scored: ScoredChunk[] = opts.corpus.map((chunk, i) => {
    const toks = docTokens[i];
    const len = toks.length || 1;
    const tf = new Map<string, number>();
    for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      score += idf(q) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { chunk, score };
  });

  scored.sort((x, y) => y.score - x.score);
  const top = scored.slice(0, k).filter((s) => s.score > 0);
  const best = top[0]?.score ?? 0;
  if (best <= floor) return { chunks: [], abstained: true };
  return { chunks: top, abstained: false };
}

/** Split a memory blob into one chunk per non-empty trimmed line. */
export function chunkMemory(memory: string): MemoryChunk[] {
  return memory
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((text, i) => ({ id: String(i), text }));
}
