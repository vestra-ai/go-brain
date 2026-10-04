/**
 * @vestra/agent-sdk generic tool layer (ring 4b-3).
 *
 * The provider-neutral tool definitions + their substrate (path confinement,
 * background-process registry, descriptions). workingDir is injected — the SDK
 * reads no environment. Web tools (search/fetch) land in ring 4b-4.
 */
export * from './tool-types.js';
export * from './result-shape.js';
export * from './fs-util.js';
export * from './descriptions/index.js';
export * from './descriptions/trimmed.js';
export * from './process-registry.js';
export * from './read-tool.js';
export * from './read-image-fit.js';
export * from './write-tool.js';
export * from './edit-tool.js';
// Hardening-I per-session read-state store (createFileViewState / checkFreshness).
// Barrel-exported so the sandbox harness can thread ONE store into the read/edit/
// write tools per session (harness-9.5 activation, FILE_STALENESS_V1).
export * from './file-view-state.js';
export * from './patch-tool.js';
export * from './patch-parser.js';
export * from './edit-normalize.js';
export * from './glob-tool.js';
export * from './grep-tool.js';
export * from './bash-tool.js';
export * from './terminal-session.js';
export * from './task-output-tool.js';
export * from './task-stop-tool.js';
export { processToolOptions, makeProcessTool } from './process-tool.js';
export * from './web-types.js';
export * from './exa-client.js';
export * from './web-providers.js';
export * from './web-search-tool.js';
export * from './web-fetch-tool.js';
export { reapWebFetchContent } from './web-content-store.js';
// The SSRF screen is shared with the server (MCP probe/OAuth egress) — one
// guard, never a second list of private ranges.
export { classifyAddress, assertPublicHost, safeFetchText, WebFetchBlockedError, type AddressClass } from './web-fetch-guard.js';
export { egressProxyVars, shellEgressMode, EGRESS_PROXY_URL_ENV, type ShellEgressMode } from './egress-proxy-env.js';
export { registerRunnerListener, unregisterRunnerListener, runnerListenerPorts, trackRunnerListener } from './runner-listener-ports.js';
// SHELL_CREDENTIAL_BROKER_V1 (S1): placeholders for the sandbox bearer in child envs.
export { CredentialBroker, BROKER_LANES, WITHHELD_RUNNER_SECRETS, PASSED_RUNNER_KEYS, withoutRunnerSecrets, brokeredSpawnEnv } from './credential-broker.js';
// Code execution (Python/Node subprocess + UDS tool bridge). Lives behind the
// I/O `/tools` entry alongside makeBashTool — NOT the pure root — because its
// substrate value-imports node:child_process / node:net (the root is re-exported
// by @bash/shared into the web bundle and must stay node-free).
export { makeExecuteCodeTool, LocalSubprocessEnvironment, DockerEnvironment } from './code-exec/index.js';
export type { ExecuteCodeOptions, DockerEnvironmentOptions } from './code-exec/index.js';
// Weave code-dispatch interpreter (the orchestration tool lives in apps/sandbox).
export { generateWeaveProgram, runWeaveScript } from './code-exec/index.js';
export type { WeaveProgramConfig, RunWeaveScriptOptions, WeaveScriptResult, WeaveBridgeDispatch } from './code-exec/index.js';
