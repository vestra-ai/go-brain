/**
 * What a recipe run tells the room while it works. The runner reports; the live card (live-search.ts) owns everything
 * the room sees. A runner calls OnProgress and never awaits it, and it never throws back into the runner.
 */
/** One picture of the page, as Bash's browser fetch returns it. */
export interface LiveFrame {
  label: string;
  /** Milliseconds from the start of the fetch. */
  at_ms: number;
  /** The page the picture shows. Only a search, results or details page is ever shown (frame-pages.ts). */
  page_url: string;
  jpeg_base64: string;
}

export type RecipeProgress =
  /** Just before the page loads, by the browser fetch or the fallback's job. */
  | { type: 'opening'; recipeId: string; url: string }
  /** The page's data is back. */
  | { type: 'captured'; ms: number }
  /** Pictures of the page, any time, oldest first. */
  | { type: 'frames'; frames: LiveFrame[] }
  /** The options are read, before Go's own constraints are applied. */
  | { type: 'extracted'; count: number }
  /** The run failed with this TravelError code. */
  | { type: 'failed'; code: string };

export type OnProgress = (e: RecipeProgress) => void;
