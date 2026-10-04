// tools/code-exec/weave-globals.ts
//
// The Weave prelude's DISPATCH vocabulary — the only two ways a Weave script starts nodes.
//
// A LEAF on purpose: this module imports nothing. weave-stub-generator.ts (which defines
// the prelude these names belong to) imports it, and so does the root wall in
// engine/subagent-walls.ts, which reads a Weave plan with them. Declaring it in the
// generator itself would drag that module's graph — the UDS bridge, node:net,
// node:fs/promises — into the walls, and through them into most of the engine, which is
// both wasteful and enough to change module-load ORDER in tests that mock node builtins.
// A list of five strings must not cost that.

/**
 * `node` starts exactly one helper (`task`, and its `agent` alias). `fanOut` starts a whole
 * layer at once: `parallel` awaits every thunk, `pipeline` flows every item independently,
 * and `panel` is best-of-N over `parallel`. That difference is what the root wall reads to
 * tell a Weave batch from a Weave hand-off — it must never retype these names, and a drift
 * pin in weave-stub-generator.test.ts asserts this constant and the GENERATED prelude still
 * name exactly the same globals, in both directions.
 */
export const WEAVE_DISPATCH_GLOBALS = {
  fanOut: ['parallel', 'pipeline', 'panel'],
  node: ['task', 'agent'],
} as const;
