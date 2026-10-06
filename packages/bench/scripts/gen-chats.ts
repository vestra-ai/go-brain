// Writes the generated chats. Run after changing a skeleton, the filler or the generator, and commit the output.
import { writeFileSync } from 'node:fs';
import { expandSkeleton, serializeChat } from '../src/generate.js';
import { GOA_2000 } from '../src/skeletons/goa-2000.js';
import { GOA_300 } from '../src/skeletons/goa-300.js';

for (const sk of [GOA_300, GOA_2000]) {
  const chat = expandSkeleton(sk);
  writeFileSync(new URL(`../chats/${sk.name}.jsonl`, import.meta.url), serializeChat(chat));
  console.log(`${sk.name}: ${chat.lines.length} lines`);
}
