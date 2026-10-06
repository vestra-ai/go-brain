// The status shapes of P4's Travel.status, exactly as P4 declares them in travel/travel.ts. On build that file
// still holds P1's placeholders until P4 lands; then diff.ts, plan.ts and runner.ts import these from
// '../travel/travel.js' again and this file goes.
export type StatusQuery =
  | { kind: 'flight'; carrierCode: string; number: string; date: string }
  | { kind: 'pnr'; pnr: string };

export type StatusResult =
  | {
      kind: 'flight';
      state: 'scheduled' | 'delayed' | 'cancelled' | 'departed' | 'landed';
      scheduledDepartAt: string;
      expectedDepartAt: string;
      delayMinutes: number;
      checkedAt: string;
    }
  | { kind: 'pnr'; state: 'confirmed' | 'waitlisted' | 'cancelled' | 'not_found'; detail: string; checkedAt: string };
