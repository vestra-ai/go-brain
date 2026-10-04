// tools/code-exec/index.ts
export { makeExecuteCodeTool } from './execute-code-tool.js';
export type { ExecuteCodeOptions } from './execute-code-tool.js';
export { LocalSubprocessEnvironment } from './local-subprocess-environment.js';
export { DockerEnvironment } from './docker-environment.js';
export type { DockerEnvironmentOptions, SpawnLike, SpawnedProc } from './docker-environment.js';
export { ToolBridgeServer } from './tool-bridge-server.js';
export { generateStub, FN_NAME_BY_TOOL, fnNamesForWhitelist } from './stub-generator.js';
export { scrubChildEnv } from './scrub-env.js';
// Weave (code-dispatch orchestration interpreter): the async-prelude program codegen
// + the subprocess/bridge runner. The orchestration tool itself lives in apps/sandbox
// (it needs the product Agent tool); this is just the interpreter plumbing.
export { generateWeaveProgram, runWeaveScript } from './weave-stub-generator.js';
export type { WeaveProgramConfig, RunWeaveScriptOptions, WeaveScriptResult, WeaveBridgeDispatch } from './weave-stub-generator.js';
