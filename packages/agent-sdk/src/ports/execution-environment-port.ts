export type ExecLanguage = 'python' | 'node';

export interface BridgeEndpoint {
  kind: 'uds' | 'tcp' | 'file';
  /** UDS socket path, `host:port`, or rpc dir. */
  address: string;
  /** Per-run nonce injected into the stub; authenticates each RPC. */
  token: string;
}

export interface ExecRequest {
  language: ExecLanguage;
  /** Generated shim header + the model's code, already assembled. */
  code: string;
  timeoutMs: number;
  cwd: string;
  /** Already secret-scrubbed by the caller. */
  env: Record<string, string | undefined>;
  bridge: BridgeEndpoint;
  /**
   * Optional cancellation. The environment forwards it to its child runtime
   * (LocalSubprocessEnvironment → execFile's `signal` option) so a user abort
   * KILLS the subprocess promptly instead of letting it run out the `timeoutMs`
   * cap (up to 5 minutes). Omitted → no cancellation (back-compat).
   */
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Runs a snippet to completion and returns raw streams. The implementation owns
 * making `req.bridge` reachable from inside its own runtime topology. Default:
 * LocalSubprocessEnvironment (same-process loopback UDS). Future: Docker/remote.
 */
export interface ExecutionEnvironment {
  run(req: ExecRequest): Promise<ExecResult>;
}
