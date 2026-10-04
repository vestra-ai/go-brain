/**
 * in-process-dispatcher.ts — the execute_code re-entry seam.
 *
 * An in-code tool (execute_code) invokes another tool BY NAME through the SAME
 * gate → execute → scan → output-guard → billing pipeline a model-driven call
 * takes. That callback, the execute-context shape it forwards, and the
 * side-effect-free pause it substitutes are this module. Extracted VERBATIM from
 * round-engine.ts, which re-exports all three — they are part of ITS contract to
 * subagent-runner and the code-exec equivalence tests.
 */
import { randomUUID } from 'node:crypto';
import { PAUSED_HALT } from '../contract/paused-halt.js';
import { gateAndDispatchTool } from './tool-dispatcher.js';
import type { RawToolOptions, ToolDispatchResult, OnAuthHalt } from '../tools/tool-types.js';
import { unknownToolText } from '../tools/result-shape.js';

/**
 * The execute-context the in-process dispatcher forwards to gateAndDispatchTool,
 * MINUS `dispatchInProcessTool` — the nested call deliberately omits it so a tool
 * invoked from INSIDE another tool (e.g. execute_code) cannot re-enter execute_code
 * and recurse forever. Derived from gateAndDispatchTool's own execCtx param so
 * `taskId`/`sessionId` stay first-class (they live on the param, not on
 * ToolExecuteContext).
 */
export type InProcessExecCtx = Omit<NonNullable<Parameters<typeof gateAndDispatchTool>[6]>, 'dispatchInProcessTool'>;

export interface InProcessDispatcherDeps {
  tools: RawToolOptions[];
  harness: { gateTool: (call: any) => Promise<any> };
  onPause: (call: any, kind: string) => Promise<string>;
  // `| undefined` (not bare optional) so callers/tests may pass `onAuthHalt: undefined`
  // explicitly under the SDK's exactOptionalPropertyTypes.
  onAuthHalt?: OnAuthHalt | undefined;
  execCtx: InProcessExecCtx;
}

/**
 * Build the callback that an in-code tool (execute_code) uses to invoke another
 * tool BY NAME, re-entering the SAME gate -> execute -> scan -> output-guard ->
 * billing pipeline a model-driven call takes. The supplied `execCtx` carries the
 * parent turn's `addCostUsd`/`signal`, so a nested tool's cost folds into the same
 * turn and an abort propagates; it OMITS `dispatchInProcessTool` so the nested
 * tool cannot recurse back into execute_code. Never throws: an unknown tool name
 * returns a `ToolDispatchResult` with `isError:true` (parity with the loop's own
 * unknown-tool sentinel). Exported + pure so it is unit-testable in isolation.
 */
/**
 * The pause callback for the IN-CODE (execute_code) dispatch path. Unlike the
 * loop's real `onPause` (which mints a durable interaction + INTERACTION_REQUIRED
 * and journal-binds a PENDING entry), this is SIDE-EFFECT-FREE: it just returns
 * the PAUSED_HALT sentinel. A tool re-entered from inside execute_code CANNOT
 * surface a HITL card — the calling subprocess is blocked on a synchronous UDS
 * RPC and the turn never actually pauses — so firing the real onPause would create
 * a PHANTOM interaction bound to an unjournaled randomUUID toolCallId that corrupts
 * resume. gateAndDispatchTool still stamps `pausedHalt`, so the bridge surfaces the
 * hard "requires human approval" error to the script and the subprocess never hangs.
 */
export const inCodePause = async (): Promise<string> => PAUSED_HALT;

export function makeInProcessDispatcher(deps: InProcessDispatcherDeps) {
  // P3.5b — optional `toolCallId` lets a caller PIN the dispatch id (Weave re-enters a
  // paused node under its ORIGINAL scope id so its journaled rounds accumulate in one
  // scope, mirroring T11b's dispatchAgentScope). Absent ⇒ randomUUID, byte-identical.
  return async function dispatchInProcessTool(name: string, input: unknown, toolCallId?: string): Promise<ToolDispatchResult> {
    const def = deps.tools.find((t) => t.name === name);
    if (!def) return { toolUseId: randomUUID(), text: unknownToolText(name, deps.execCtx.toolErrorTaxonomy), isError: true };
    return gateAndDispatchTool(def, input, toolCallId ?? randomUUID(), deps.harness, deps.onPause, deps.onAuthHalt, deps.execCtx);
  };
}
