// What a proactive desk item carries: what Go noticed, what the bar allows this turn, and the trip's zone.
import { z } from 'zod';
import type { DeskItem } from '../desk/desk.js';
import { ACTIONS, type Candidate, type Decision } from './policy.js';

export const PROACTIVE_KINDS = ['timer', 'watch', 'opening'] as const;
const When = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'a date');

export const ProactivePayload = z.object({
  candidate: z.object({
    tripId: z.string(),
    dedupeKey: z.string(),
    source: z.enum(PROACTIVE_KINDS),
    topic: z.string(),
    dueAt: When,
    expiresAt: When.nullable(),
    importance: z.number(),
    confidence: z.number(),
    urgency: z.number(),
    useful: z.array(z.enum(ACTIONS)),
    personIds: z.array(z.string()),
    facts: z.record(z.string(), z.unknown()),
    simulated: z.boolean(),
    small: z.boolean(),
    forced: z.boolean().default(false),
    asked: z.boolean().default(false),
  }),
  allowed: z.array(z.enum(ACTIONS)).min(1),
  forPersonIds: z.array(z.string()),
  tz: z.string(),
});
export type ProactivePayload = z.infer<typeof ProactivePayload>;

export function toPayload(c: Candidate, d: Extract<Decision, { kind: 'go' }>, tz: string): ProactivePayload {
  return {
    candidate: { ...c, forced: c.forced === true, asked: c.asked === true, dueAt: c.dueAt.toISOString(), expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null },
    allowed: d.allowed,
    forPersonIds: d.forPersonIds,
    tz,
  };
}

export function fromPayload(p: ProactivePayload['candidate']): Candidate {
  return { ...p, dueAt: new Date(p.dueAt), expiresAt: p.expiresAt ? new Date(p.expiresAt) : null };
}

/** The proactive payload of a desk item, or null when a person, a tap or a task put the item there. */
export function proactiveOf(item: DeskItem): ProactivePayload | null {
  if (!(PROACTIVE_KINDS as readonly string[]).includes(item.kind)) return null;
  const r = ProactivePayload.safeParse(item.payload);
  return r.success ? r.data : null;
}

/** Lane-prefixed and stable: `timer:<trip>:<key>`, `watch:<trip>:<key>`, `opening:<trip>:<key>`. */
export const deskId = (c: Pick<Candidate, 'source' | 'tripId' | 'dedupeKey'>): string => `${c.source}:${c.tripId}:${c.dedupeKey}`;
