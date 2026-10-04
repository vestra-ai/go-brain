import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

/** Who said it. go-brain never sees members' contact details, only what the group sees. */
export const MemberRef = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  photo_url: z.url().optional(),
});

export const Attachment = z.object({
  kind: z.literal('photo'),
  url: z.url(),
  caption: z.string().max(500).optional(),
});

/**
 * go-server → go-brain: one message someone posted in a trip room.
 * go-server sends every message (Go listens to all of them) and marks whether it addressed Go;
 * go-brain decides whether Go speaks (the speaking rule).
 */
export const MessageIn = z.object({
  message_id: Id,
  trip_id: Id,
  member: MemberRef,
  text: z.string().max(4000),
  /** Set when this message replies to another message in the room. */
  reply_to: Id.optional(),
  /** True when it replies to one of Go's messages: that counts as addressing Go. */
  reply_to_go: z.boolean().default(false),
  /** True when the text @mentions Go. */
  mentions_go: z.boolean().default(false),
  attachments: z.array(Attachment).max(10).default([]),
  sent_at: IsoDateTime,
});
export type MessageIn = z.infer<typeof MessageIn>;

export const MessageInAccepted = z.object({ accepted: z.literal(true) });
