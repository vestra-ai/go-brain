/**
 * Types for the three undici modules warm-connections.ts imports by path. They are
 * imported by path, not from the package root, because the root's index runs
 * `setGlobalDispatcher(new Agent())` on load when no global dispatcher exists yet,
 * which would swap the dispatcher behind EVERY built-in `fetch` in the runner,
 * flag on or off. These three files touch no global.
 */
declare module 'undici/lib/dispatcher/agent.js' {
  import type { Agent } from 'undici';
  const AgentClass: typeof Agent;
  export default AgentClass;
}

declare module 'undici/lib/core/connect.js' {
  import type { buildConnector } from 'undici';
  const build: typeof buildConnector;
  export default build;
}

declare module 'undici/lib/dispatcher/dispatcher.js' {
  import type { Dispatcher } from 'undici';
  const DispatcherClass: typeof Dispatcher;
  export default DispatcherClass;
}
