/**
 * K4-T10 — Ability eval Stop-gate scaffold (schema only).
 *
 * ADDITIVE-ONLY: these types extend AbilityManifest but do not introduce
 * a new JournalPayload variant and do NOT widen compact_boundary.
 *
 * The kernel runner (`runAbilityEvals`) is the only consumer in K4.
 * The harness wiring (invoking the runner at ability-ship time) is
 * DEFERRED — no production invocation path exists yet.
 */

// TODO(oss): Vestra ability/eval concept — convert to an injected port at ring 4 (see spec §12.2).

/**
 * A single eval declaration inside an ability's manifest.
 * `kind:'script'` — the harness resolves the entrypoint at ship time.
 * The kernel itself never imports or executes an entrypoint directly.
 */
export interface AbilityEval {
  /** Human-readable name identifying this eval (e.g. "invoice-format-check"). */
  name: string;
  /** Discriminant for future extensibility. Currently only 'script' is defined. */
  kind: 'script';
  /**
   * Relative path within the ability directory to the eval entry point.
   * The kernel NEVER resolves this path — the EvalRunner callback is
   * injected by the harness, which owns FS resolution.
   */
  entrypoint: string;
  /** Optional human-readable description of what this eval checks. */
  description?: string;
}

/** Result returned by a single EvalRunner invocation. */
export interface EvalRunResult {
  /** Whether the eval passed. */
  pass: boolean;
  /** Human-readable reason for failure (present when pass is false). */
  reason?: string;
}

/**
 * A harness-injected callback that executes one AbilityEval.
 *
 * The kernel never resolves an entrypoint itself — it calls this
 * function with the eval descriptor and an optional AbortSignal, and
 * expects an EvalRunResult in return. The harness owns FS I/O.
 *
 * Implementors MUST NOT throw — the kernel wraps every call in try/catch,
 * but returning { pass: false, reason } is preferred over throwing.
 */
export type EvalRunner = (eval_: AbilityEval, signal?: AbortSignal) => Promise<EvalRunResult>;
