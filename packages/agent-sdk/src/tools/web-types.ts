/** Canonical web-tool shapes — provider-neutral; consumed by the FE WebSearchCard. */
export interface CanonicalSearch {
  query: string;
  durationSeconds: number | null;
  results: Array<{ content: Array<{ title: string; url: string }>; excerpts: string[]; publish_date: string | null }>;
}
export interface CanonicalFetch { url: string; content: string }
