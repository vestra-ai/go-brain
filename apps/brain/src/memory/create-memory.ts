/** The Memory interface the composer and Go's MCP server read (master §6.3). */
import type { Pool } from 'pg';
import type { Packs } from '../trips/pack.js';
import { checkFact } from './checker.js';
import { forgottenUpTo, saveFact } from './facts.js';
import type { Memory } from './memory.js';
import { drawPage } from './pages.js';
import { recall } from './recall.js';
import { recordLines } from './record.js';

export function createMemory(d: { pool: Pool; packs: Packs }): Memory {
  return {
    page: (tripId, personId, audience) => drawPage(d.pool, tripId, personId, audience),
    async recall(tripId, question, audience) {
      const pack = await d.packs.get(tripId);
      return recall(d.pool, pack, await forgottenUpTo(d.pool, tripId), question, audience);
    },
    async note(tripId, input) {
      const pack = await d.packs.get(tripId);
      const env = { pack, forgotten: await forgottenUpTo(d.pool, tripId), record: await recordLines(d.pool, tripId) };
      const c = checkFact(
        { person_id: input.personId, topic: input.topic, text: input.text, message_id: input.proofMessageId, audience: input.audience },
        env,
      );
      if (!c.ok) return 'refused';
      await saveFact(d.pool, { ...c.value, source: 'note' });
      return 'saved';
    },
  };
}
