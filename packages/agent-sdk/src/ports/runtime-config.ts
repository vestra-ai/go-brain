/**
 * RuntimeConfig — injected runtime values. Replaces every process.env read in the
 * engine; the SDK reads no environment directly.
 *
 * These are PROCESS-wide (one box = one user; the product builds this from the
 * runner's env). It deliberately carries NO session id: one runner process serves
 * many sessions, so a session id here would be the session that started the runner
 * stamped onto every other session (the X1b hook-input bug). A run's own session id
 * is `HarnessContext.sessionId`.
 */
export interface RuntimeConfig {
  workingDir: string;
  userId: string;
  mcpServerConfig?: string | undefined;
  systemPrompt: string;
}

export function makeRuntimeConfig(
  p: Partial<RuntimeConfig> & { systemPrompt: string },
): RuntimeConfig {
  return {
    workingDir: p.workingDir ?? '.',
    userId: p.userId ?? '',
    mcpServerConfig: p.mcpServerConfig,
    systemPrompt: p.systemPrompt,
  };
}
