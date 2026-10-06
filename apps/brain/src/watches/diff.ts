// Which change between two status readings is worth a nudge. Readings are P4's StatusResult as they are.
// Each change has a key: the same change is nudged once.
import type { Action } from '../proactive/policy.js';
import type { StatusQuery, StatusResult } from './status.js';

/** What a watch checks: P4's status kinds, a flight by its number or a train ticket by its PNR. */
export type WatchKind = StatusQuery['kind'];

export interface WatchInfo {
  watchId: string;
  kind: WatchKind;
  label: string;
  /** Go already posted a notice for this watch, so a change can update it in place. */
  hasNotice: boolean;
  /** The watch concerns particular people (the booking's travellers), so a pin can reach just them. */
  hasPeople: boolean;
  /** When the watch stops: an hour after a flight lands, or when a train leaves. */
  endsAt: Date;
}

export interface WatchChange {
  changeKey: string;
  importance: number;
  confidence: number;
  urgency: number;
  small: boolean;
  useful: Action[];
  facts: Record<string, unknown>;
}

const DELAY_STEP = 15;
const DELAY_FLAG = 30;
const H = 3600_000;

type Flight = Extract<StatusResult, { kind: 'flight' }>;
type Pnr = Extract<StatusResult, { kind: 'pnr' }>;

const urgencyIn = (hoursToGo: number): number => (hoursToGo <= 6 ? 0.9 : hoursToGo <= 24 ? 0.7 : 0.4);

function flightChange(w: WatchInfo, before: Flight | null, after: Flight, now: Date): WatchChange | null {
  // People act before the time they planned around, so urgency counts to the scheduled departure.
  const urgency = urgencyIn((Date.parse(after.scheduledDepartAt) - now.getTime()) / H);
  const posts: Action[] = w.hasPeople ? ['pin', 'message'] : ['message'];
  const facts: Record<string, unknown> = {
    state: after.state,
    delayMinutes: after.delayMinutes,
    scheduledDepartAt: after.scheduledDepartAt,
    expectedDepartAt: after.expectedDepartAt,
    ...(before ? { beforeDelayMinutes: before.delayMinutes, beforeState: before.state } : {}),
  };
  if (after.state === 'cancelled') {
    if (before?.state === 'cancelled') return null;
    return { changeKey: `${w.watchId}:cancelled`, importance: 1, confidence: 0.95, urgency, small: false, useful: posts, facts };
  }
  const step = Math.floor(after.delayMinutes / DELAY_STEP) * DELAY_STEP;
  const was = before ? Math.floor(before.delayMinutes / DELAY_STEP) * DELAY_STEP : 0;
  if (step >= DELAY_FLAG && step !== was) {
    const useful: Action[] = w.hasNotice ? ['update_card', ...posts] : posts;
    return { changeKey: `${w.watchId}:delay:${step}`, importance: step >= 60 ? 0.9 : 0.7, confidence: 0.95, urgency, small: false, useful, facts };
  }
  if (step < DELAY_FLAG && was >= DELAY_FLAG && w.hasNotice) {
    return { changeKey: `${w.watchId}:ontime:${after.expectedDepartAt}`, importance: 0.6, confidence: 0.95, urgency, small: false, useful: ['update_card'], facts };
  }
  return null;
}

function pnrChange(w: WatchInfo, before: Pnr | null, after: Pnr, now: Date): WatchChange | null {
  if (after.state === 'not_found' || after.state === before?.state) return null;
  const urgency = urgencyIn((w.endsAt.getTime() - now.getTime()) / H);
  const posts: Action[] = w.hasPeople ? ['pin', 'message'] : ['message'];
  const facts: Record<string, unknown> = { state: after.state, detail: after.detail, ...(before ? { beforeState: before.state } : {}) };
  if (after.state === 'cancelled') {
    return { changeKey: `${w.watchId}:cancelled`, importance: 1, confidence: 0.95, urgency, small: false, useful: posts, facts };
  }
  if (after.state === 'confirmed' && before?.state === 'waitlisted') {
    return { changeKey: `${w.watchId}:confirmed`, importance: 0.6, confidence: 0.95, urgency, small: false, useful: posts, facts };
  }
  return null;
}

export function diffReading(w: WatchInfo, before: StatusResult | null, after: StatusResult, now: Date): WatchChange | null {
  switch (after.kind) {
    case 'flight':
      return flightChange(w, before?.kind === 'flight' ? before : null, after, now);
    case 'pnr':
      return pnrChange(w, before?.kind === 'pnr' ? before : null, after, now);
  }
}
