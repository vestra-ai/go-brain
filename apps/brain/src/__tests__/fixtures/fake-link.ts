import { SocketCallError } from '../../door/rpc.js';
import type { ServerLink } from '../../door/server-link.js';

export type FakeAnswers = Record<string, (params: any) => unknown>;

/** A ServerLink that answers from a map of method to function and records every call. */
export function fakeLink(answers: FakeAnswers = {}) {
  const calls: Array<{ method: string; params: any; turnId?: string }> = [];
  const notes: Array<{ method: string; params: any }> = [];
  const link: ServerLink = {
    async request(method, params, opts) {
      calls.push({ method, params, ...(opts?.turnId ? { turnId: opts.turnId } : {}) });
      const f = answers[method];
      if (!f) throw new SocketCallError(-32601, `the fake Server has no ${method}`);
      return (await f(params)) as never;
    },
    notify(method, params) {
      notes.push({ method, params });
    },
    isOpen: () => true,
  };
  return { link, calls, notes };
}
