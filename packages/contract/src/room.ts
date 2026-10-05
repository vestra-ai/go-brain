import { z } from 'zod';
import { Card } from './cards.js';
import { Actor, HttpUrl, Id, IsoDateTime, Seq } from './common.js';

/** Photo and file URLs must stay fetchable for at least an hour; go-brain copies what it keeps. */
export const Attachment = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('photo'),
      url: HttpUrl,
      width: z.int().positive().nullish(),
      height: z.int().positive().nullish(),
      caption: z.string().max(500).nullish(),
    }).meta({ id: 'PhotoAttachment' }),
    z.object({
      kind: z.literal('file'),
      url: HttpUrl,
      name: z.string().min(1).max(200),
      mime: z.string().min(1).max(100),
      size_bytes: z.int().nonnegative(),
    }).meta({ id: 'FileAttachment' }),
  ])
  .meta({ id: 'Attachment', discriminator: { propertyName: 'kind' } });

export const Reaction = z.object({ emoji: z.string().min(1).max(16), person_id: Id }).meta({ id: 'Reaction' });

/** One message in a trip room, as go-server stores it. */
export const Message = z
  .object({
    message_id: Id,
    seq: Seq,
    author: Actor,
    /** Null when the message was deleted, or its author paused Go (`withheld`). */
    text: z.string().max(4000).nullish(),
    attachments: z.array(Attachment).max(10),
    reply_to: Id.nullish(),
    /** Set when someone long-pressed a message and chose "Ask Go about this". */
    about_message_id: Id.nullish(),
    /** True when the text @mentions Go, names Go, or replies to one of Go's messages. */
    mentions_go: z.boolean(),
    /** People @mentioned in the text. */
    mentions: z.array(Id).max(30),
    reactions: z.array(Reaction).max(100),
    /** Only on Go's messages. */
    card: Card.nullish(),
    /** True when the author paused Go: the text and attachments are left out on purpose. */
    withheld: z.boolean(),
    deleted: z.boolean(),
    edited_at: IsoDateTime.nullish(),
    sent_at: IsoDateTime,
  })
  .meta({ id: 'Message' });
export type Message = z.infer<typeof Message>;

export const MessagesPage = z
  .object({ messages: z.array(Message).max(200), has_more: z.boolean() })
  .meta({ id: 'MessagesPage' });

/** Go says something in the room: text, a card, or both. */
export const PostMessage = z
  .object({
    /** Go's id for this request. go-server must do it once even if it arrives twice. */
    request_id: Id,
    text: z.string().min(1).max(2000).nullish(),
    card: Card.nullish(),
    reply_to: Id.nullish(),
    /** People Go names in the text. They get a push. */
    mentions: z.array(Id).max(30).nullish(),
  })
  .refine((m) => m.text != null || m.card != null, { message: 'a message needs text, a card, or both' })
  .meta({ id: 'PostMessage', description: 'Needs text, a card, or both.' });
export type PostMessage = z.infer<typeof PostMessage>;

export const PostMessageResult = z.object({ message_id: Id, seq: Seq }).meta({ id: 'PostMessageResult' });

/** Replace a card Go posted earlier (same `card_id`), e.g. a call that moved from dialing to talking. */
export const PutCardResult = z.object({ message_id: Id }).meta({ id: 'PutCardResult' });

/** "Go is typing...". Shown for up to 10 seconds, or until Go's next message lands. Go repeats it while it works. */
export const SetTyping = z.object({ on: z.boolean() }).meta({ id: 'SetTyping' });
