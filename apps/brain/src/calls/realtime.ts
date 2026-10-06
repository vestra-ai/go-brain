// What the voice model is told on a call, the one tool it has on gpt-realtime, and the socket to it.
import WebSocket from 'ws';
import { z } from 'zod';
import { LIVE_URL, REALTIME_URL, voiceKind, type VoiceKind } from './config.js';

export interface CallBrief { business: string; goal: string; factsAllowed: string[]; forWhom: string }
/** The voice model and its voice. There is no transcription setting: Go hears with the voice model's own ears only. */
export interface SessionSettings { model: string; voice: string }

/** Go's first line on every call: it says it is an AI assistant. */
export function greeting(b: CallBrief): string {
  return `Hi, this is Go, an AI assistant calling for ${b.forWhom}.`;
}

export function callInstructions(b: CallBrief, kind: VoiceKind): string {
  const facts = b.factsAllowed.length > 0 ? b.factsAllowed.map((f) => `- ${f}`).join('\n') : '- Nothing beyond the question itself.';
  const report = kind === 'realtime'
    ? '- As soon as you have the answer, or it is clear you cannot get it, call report_outcome with the outcome in one or two plain sentences. Then thank them and say goodbye.'
    : '- As soon as you have the answer, or it is clear you cannot get it, say it back to them in one short sentence that starts with "So," (for example "So, check-in at 10 am is fine."), then hand off (delegate). When you are told to, thank them and say goodbye.';
  return [
    `You are Go, an AI assistant, on a phone call to ${b.business} on behalf of ${b.forWhom}.`,
    `When they answer, say first: "${greeting(b)}" Then ask your question.`,
    `Your goal: ${b.goal}`,
    'Facts you may share if they help, and nothing else about the group:',
    facts,
    'Rules:',
    '- Never pay, never agree to pay, and never give card, bank, UPI or login details. If they ask for payment, say the group will pay separately.',
    '- Never share phone numbers, emails or anything not listed above.',
    '- Never say which company made you or which model you are. You are Go.',
    '- Be brief and polite. Short sentences. Speak English; if they answer in Hindi, speak Hindi.',
    '- If they ask you to hold, wait quietly.',
    report,
  ].join('\n');
}

export const REPORT_OUTCOME_TOOL = {
  type: 'function',
  name: 'report_outcome',
  description: 'Report what came of the call, once, before saying goodbye.',
  parameters: {
    type: 'object',
    properties: {
      outcome: { type: 'string', description: 'What they said, in one or two plain sentences for the group.' },
      answered: { type: 'boolean', description: 'True when the business answered the question.' },
      record: {
        type: ['object', 'null'],
        description: 'Set when the answer settles something the group should keep (agreed) or still decide (open).',
        properties: {
          kind: { type: 'string', enum: ['agreed', 'open'] },
          text: { type: 'string', description: 'One short line for the trip record.' },
        },
        required: ['kind', 'text'],
      },
    },
    required: ['outcome', 'answered'],
  },
} as const;

export const ReportedOutcome = z.object({
  outcome: z.string().min(1).max(500),
  answered: z.boolean(),
  record: z.object({ kind: z.enum(['agreed', 'open']), text: z.string().min(1).max(200) }).nullable().optional(),
});
export type ReportedOutcome = z.infer<typeof ReportedOutcome>;

/** A plain WebSocket to the voice model (no SDK: the repo pins an older SDK for the copied agent loop). */
export function openVoice(o: { model: string; apiKey: string }): WebSocket {
  const headers = { Authorization: `Bearer ${o.apiKey}` };
  return voiceKind(o.model) === 'live'
    ? new WebSocket(LIVE_URL, { headers })
    : new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(o.model)}`, { headers });
}
