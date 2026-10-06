/**
 * Lane B (P2) owns this file. P1 creates it so Brain compiles; P2 implements Memory elsewhere in memory/
 * and sets brain.memory.
 */
export interface Memory {
  /** Drawn from facts: this trip's, plus other trips' only when the person turned carry-over on. One line per fact with its proof. */
  page(tripId: string, personId: string, audience: 'group' | 'go'): Promise<string>;
  recall(tripId: string, question: string, audience: 'group' | 'go'): Promise<Array<{ text: string; messageId: string; seq: number }>>;
  /** A suggestion; code checks the proof before it becomes a fact. `topic` is the contract's Fact.topic. */
  note(
    tripId: string,
    input: { personId: string; topic: string; text: string; proofMessageId: string; audience: 'group' | 'go' },
  ): Promise<'saved' | 'refused'>;
}
