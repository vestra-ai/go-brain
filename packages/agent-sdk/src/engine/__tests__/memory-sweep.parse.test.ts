/**
 * memory-sweep — the FACT-line parse table and the type vocabulary it mints.
 *
 * The parser is deliberately LENIENT about SHAPE (a real fact must never be dropped over
 * formatting) and deliberately CLOSED about TYPE: a bracketed type outside EPISTEMIC_SET
 * downgrades to 'other' rather than being minted. That closed set is the thing this suite
 * guards, because a silent downgrade is invisible in production — the fact still deposits,
 * it just lands in the wrong lane's slice and nothing ever reports it.
 *
 * 2026-08-21: `procedure` joins the set. The 9-member union in @bash/shared always allowed it
 * and the procedures fold reads exactly the `{ only: 'procedure' }` slice, so until now every
 * procedural fact the sweep found deposited as 'other' and was swept by the profile/moments
 * lane instead. `retraction` stays out on purpose: see the comment on EPISTEMIC_SET.
 */
import { describe, it, expect } from 'vitest';
import { parseMemorySweep, MEMORY_SWEEP_PROMPT, depositEventData } from '../memory-sweep.js';

/** The types the prompt names, in the order it names them. */
const PROMPT_TYPES = [
  'identity',
  'relationship',
  'commitment',
  'preference',
  'project_state',
  'procedure',
  'correction',
  'other',
] as const;

describe('parseMemorySweep — the type table', () => {
  it.each(PROMPT_TYPES)('mints the bracketed type %s', (type) => {
    expect(parseMemorySweep(`FACT [${type}] The user ships on Fridays.`)).toEqual([
      { epistemic: type, observation: 'The user ships on Fridays.' },
    ]);
  });

  it('mints procedure from the bare-with-colon shape too', () => {
    expect(parseMemorySweep('FACT procedure: deploys only after the staging soak')).toEqual([
      { epistemic: 'procedure', observation: 'deploys only after the staging soak' },
    ]);
  });

  it('downgrades a type outside the set to other, keeping the sentence', () => {
    // 'retraction' is a member of the SHARED union but not of the sweep's set: the sweep only
    // ever adds, so it must never mint a kill signal for a fact it cannot see.
    expect(parseMemorySweep('FACT [retraction] No longer true: the user prefers dark mode.')).toEqual([
      { epistemic: 'other', observation: 'No longer true: the user prefers dark mode.' },
    ]);
    expect(parseMemorySweep('FACT [nonsense] The user builds Vestra.')).toEqual([
      { epistemic: 'other', observation: 'The user builds Vestra.' },
    ]);
  });

  it('keeps a date that rides inside the sentence (the moments fold routes on it)', () => {
    const facts = parseMemorySweep(
      '- FACT [commitment] Promised Priya the investor update by Friday the 22nd.',
    );
    expect(facts).toEqual([
      { epistemic: 'commitment', observation: 'Promised Priya the investor update by Friday the 22nd.' },
    ]);
  });
});

describe('MEMORY_SWEEP_PROMPT — the vocabulary the parser is the other half of', () => {
  it('names every type the parser mints, and no type it would downgrade', () => {
    const typeList = MEMORY_SWEEP_PROMPT.slice(MEMORY_SWEEP_PROMPT.indexOf('where type is one of:'));
    for (const type of PROMPT_TYPES) expect(typeList, type).toContain(type);
    // Asking for a retraction the parser downgrades would waste a line every sweep.
    expect(typeList).not.toContain('retraction');
  });

  it('teaches procedure with a worked example', () => {
    expect(MEMORY_SWEEP_PROMPT).toContain('"FACT [procedure] "');
    expect(MEMORY_SWEEP_PROMPT).toContain('deploys only after the staging soak');
  });

  it('tells the model to keep the date IN the sentence and never to invent one', () => {
    expect(MEMORY_SWEEP_PROMPT).toContain('keep the date IN the sentence');
    expect(MEMORY_SWEEP_PROMPT).toContain('"by Friday the 22nd"');
    expect(MEMORY_SWEEP_PROMPT).toContain('Never invent a date.');
  });

  // The file's own copy rule (see the doc comment): no vendor names, no em dashes.
  it('carries no em dash', () => {
    expect(MEMORY_SWEEP_PROMPT).not.toContain('—');
  });
});

/**
 * THE GROUNDING TOKEN (2026-08-22).
 *
 * The sweep used to stamp EVERY harvested fact `source: 'agent_inferred'`, a
 * constant. That made the authority ladder a dead letter on the procedures lane:
 * the sweep is the only agent-side producer of `procedure`, so every procedure in
 * the system entered at the bottom rung, and the fold's "1. user_direct (the user
 * said it)" rung was unreachable. A model that had emailed a summary three times
 * because three tasks asked it to could therefore write "the user prefers a summary
 * by email" into the standing procedures file, on the strength of its OWN actions.
 *
 * The FACT line now carries an optional grounding token right after the type. The
 * default is unchanged (absent ⇒ agent_inferred, byte-identical to the shipped
 * behaviour), so a model that ignores the grammar loses a procedure rather than
 * inventing one. Failing SAFE is the whole point of putting the default there.
 */
describe('parseMemorySweep — the grounding token', () => {
  it('reads a stated source and keeps the sentence clean', () => {
    expect(parseMemorySweep('FACT [procedure] (user_direct) Send the weekly update on Friday.')).toEqual([
      { epistemic: 'procedure', source: 'user_direct', observation: 'Send the weekly update on Friday.' },
    ]);
    expect(parseMemorySweep('FACT [project_state] (tool_observed) The Ixigo contract renews in March.')).toEqual([
      { epistemic: 'project_state', source: 'tool_observed', observation: 'The Ixigo contract renews in March.' },
    ]);
  });

  it('leaves the source ABSENT when the model states none (the safe default lives downstream)', () => {
    const [fact] = parseMemorySweep('FACT [procedure] Send the weekly update on Friday.');
    expect(fact.source).toBeUndefined();
  });

  it('treats a parenthetical that is NOT a source token as plain sentence text', () => {
    // Lenient about shape, closed about vocabulary: the same contract the type
    // bracket already has. Eating a real opening clause would corrupt the fact.
    expect(parseMemorySweep('FACT [preference] (as he put it) keep the deck to five slides.')).toEqual([
      { epistemic: 'preference', observation: '(as he put it) keep the deck to five slides.' },
    ]);
  });

  it("never mints the sources that are not the agent's to claim", () => {
    // 'upload' and 'screen' belong to non-agent depositors (an upload handler, a
    // screen pipeline). A sweep line claiming one is sentence text, not a tag.
    const [fact] = parseMemorySweep('FACT [procedure] (upload) something the agent cannot have seen that way.');
    expect(fact.source).toBeUndefined();
    expect(fact.observation).toContain('(upload)');
  });

  it('works on the bare-with-colon shape too', () => {
    expect(parseMemorySweep('FACT procedure: (user_direct) deploys only after the staging soak')).toEqual([
      { epistemic: 'procedure', source: 'user_direct', observation: 'deploys only after the staging soak' },
    ]);
  });
});

describe('depositEventData — the wire carries the grounding, not a constant', () => {
  it('sends the stated source', () => {
    expect(depositEventData('task-1', { epistemic: 'procedure', source: 'user_direct', observation: 'x' })).toEqual({
      taskId: 'task-1',
      source: 'user_direct',
      epistemic: 'procedure',
      observation: 'x',
    });
  });

  it("floors an unstated source at 'agent_inferred' — a claim of authority is never a default", () => {
    expect(depositEventData('task-1', { epistemic: 'preference', observation: 'x' })).toEqual({
      taskId: 'task-1',
      source: 'agent_inferred',
      epistemic: 'preference',
      observation: 'x',
    });
  });
});

describe('MEMORY_SWEEP_PROMPT — what the agent did is never evidence about the user', () => {
  it('teaches the grounding token', () => {
    expect(MEMORY_SWEEP_PROMPT).toContain('(user_direct)');
    expect(MEMORY_SWEEP_PROMPT).toContain('(tool_observed)');
  });

  it('names the trap in so many words: your own actions are not the user preferring something', () => {
    expect(MEMORY_SWEEP_PROMPT).toContain('What you did yourself is never evidence of what the user wants');
  });

  it('tells the model a procedure needs the user to have said or chosen it', () => {
    const proc = MEMORY_SWEEP_PROMPT.slice(MEMORY_SWEEP_PROMPT.indexOf('What you did yourself'));
    expect(proc).toContain('said or chose');
  });
});

/**
 * TELL IT ONCE (2026-09-25). A cofounder told the agent fifteen times across four tasks to post
 * each reply in its matching thread, one by one, and nothing was ever written down: the prompt
 * read a delivery rule as "how you carried out the task". The rule is a procedure; the agent's
 * own mechanics still are not; and the grounding lesson of 08-22 stays word for word.
 */
describe('MEMORY_SWEEP_PROMPT: a delivery rule the person states is a procedure', () => {
  it("scopes the do-not-capture rule to the agent's own mechanics, keeping the grounding lesson word for word", () => {
    expect(MEMORY_SWEEP_PROMPT).toContain(
      'That rule is about your own mechanics; it never covers a rule the user gave you about how their work must be delivered.',
    );
    expect(MEMORY_SWEEP_PROMPT).toContain('What you did yourself is never evidence of what the user wants');
    expect(MEMORY_SWEEP_PROMPT).toContain('never turn one instruction into a rule for a whole class of tasks');
  });

  it('names a stated delivery rule a procedure, with vendor-free examples and the scope rule', () => {
    expect(MEMORY_SWEEP_PROMPT).toContain('A rule the user states about how their work is delivered IS a procedure');
    expect(MEMORY_SWEEP_PROMPT).toContain('"send them one by one, never in bulk"');
    expect(MEMORY_SWEEP_PROMPT).toContain('keep the scope they gave it, no wider');
    expect(MEMORY_SWEEP_PROMPT).not.toMatch(/\b(?:Slack|Gmail|Google|Twitter|OpenAI|Anthropic|Claude|Notion|WhatsApp)\b|\bX\b/);
    expect(MEMORY_SWEEP_PROMPT).not.toContain('—');
  });

  it("asks for the person's exact words on a QUOTE line, with their standing words, and forbids quoting anyone else", () => {
    expect(MEMORY_SWEEP_PROMPT).toContain('QUOTE "their exact words"');
    expect(MEMORY_SWEEP_PROMPT).toContain('when they said always, never, from now on or the like, keep those words in the quote');
    expect(MEMORY_SWEEP_PROMPT).toContain('Never write a quote they did not type, and never quote yourself, a tool, or a helper.');
  });

  it("its worked example never claims more than its quote shows: the fact's scope rides in the quote", () => {
    // The model copies this pair. A fact wider than its quote (a "never in bulk" the quote never
    // said) would, once the server verifies the quote, store the wider rule as the person's own.
    const at = MEMORY_SWEEP_PROMPT.indexOf('For example:\nFACT [procedure]');
    expect(at).toBeGreaterThan(-1);
    const [example] = parseMemorySweep(MEMORY_SWEEP_PROMPT.slice(at));
    expect(example).toStrictEqual({
      epistemic: 'procedure',
      source: 'user_direct',
      observation: 'Wants each drafted reply posted in its matching thread, one at a time, never in bulk.',
      quote: 'post each reply in the matching thread, one by one, never in bulk',
    });
    expect(example.observation).toContain('never in bulk');
    expect(example.quote).toContain('never in bulk');
  });

  it('names the relay label exactly as the server writes it (person-words.ts THEIR_WORDS_LEAD), and never quotes the relayed instruction', () => {
    expect(MEMORY_SWEEP_PROMPT).toContain('A message may end with the user\'s own words after "In their words:".');
    expect(MEMORY_SWEEP_PROMPT).toContain('so it is never a quote.');
  });
});

describe("parseMemorySweep: the QUOTE line (the person's own words)", () => {
  it('attaches a QUOTE line to the FACT line directly above it, and only to that one', () => {
    expect(
      parseMemorySweep(
        'FACT [procedure] (user_direct) Wants each reply posted in its matching thread.\n' +
          'QUOTE "post each reply in the matching thread, one by one"',
      ),
    ).toStrictEqual([
      {
        epistemic: 'procedure',
        source: 'user_direct',
        observation: 'Wants each reply posted in its matching thread.',
        quote: 'post each reply in the matching thread, one by one',
      },
    ]);
    // A fact with no QUOTE line carries no quote key: its deposit is byte-identical to before.
    expect(parseMemorySweep('FACT [identity] The user builds Vestra.')).toStrictEqual([
      { epistemic: 'identity', observation: 'The user builds Vestra.' },
    ]);
    expect(parseMemorySweep('FACT [identity] The user builds Vestra.')[0]).not.toHaveProperty('quote');
    // Prose between the two breaks the pairing; a lone QUOTE line attaches to nothing.
    const facts = parseMemorySweep('FACT [identity] The user builds Vestra.\nsome prose\nQUOTE "one by one, never in bulk"');
    expect(facts[0]).not.toHaveProperty('quote');
    expect(parseMemorySweep('QUOTE "one by one, never in bulk"')).toEqual([]);
  });

  it('is lenient about shape: colon, bullet, curly or missing marks, lowercase, a blank line between', () => {
    for (const q of [
      'QUOTE: "one by one, never in bulk"',
      '- quote “one by one, never in bulk”',
      'Quote: one by one, never in bulk',
      '\nQUOTE "one by one, never in bulk',
    ]) {
      const [fact] = parseMemorySweep(`FACT [procedure] (user_direct) Sends drafts one at a time.\n${q}`);
      expect(fact.quote, q).toBe('one by one, never in bulk');
    }
  });

  it('tolerates the quote inline at the END of the fact line, and never eats a sentence that merely says quote', () => {
    const [inline] = parseMemorySweep('FACT [procedure] (user_direct) Sends drafts one at a time. QUOTE: "one by one, never in bulk"');
    expect(inline).toMatchObject({ observation: 'Sends drafts one at a time.', quote: 'one by one, never in bulk' });

    const [prose] = parseMemorySweep('FACT [project_state] (user_direct) He wants a price quote: three options by Friday.');
    expect(prose.observation).toBe('He wants a price quote: three options by Friday.');
    expect(prose).not.toHaveProperty('quote');
  });

  it('never cuts a fact at an uppercase QUOTE mid-sentence: the inline form must close the line', () => {
    const [mid] = parseMemorySweep('FACT [project_state] The user needs a QUOTE "by Friday" for Acme.');
    expect(mid).toStrictEqual({ epistemic: 'project_state', observation: 'The user needs a QUOTE "by Friday" for Acme.' });
    // A closing mark followed only by a trailing period, comma or semicolon still closes the line.
    const [dotted] = parseMemorySweep('FACT [procedure] (user_direct) Sends drafts one at a time. QUOTE: “one by one, never in bulk”.');
    expect(dotted).toStrictEqual({
      epistemic: 'procedure',
      source: 'user_direct',
      observation: 'Sends drafts one at a time.',
      quote: 'one by one, never in bulk',
    });
  });
});

describe('depositEventData: the quote rides the wire only when there is one', () => {
  it('sends the quote', () => {
    expect(
      depositEventData('task-1', { epistemic: 'procedure', source: 'user_direct', observation: 'x', quote: 'one by one, never in bulk' }),
    ).toStrictEqual({ taskId: 'task-1', source: 'user_direct', epistemic: 'procedure', observation: 'x', quote: 'one by one, never in bulk' });
  });

  it('sends no quote key at all for a fact without one: the deposit is byte-identical to before', () => {
    const data = depositEventData('task-1', { epistemic: 'preference', observation: 'x' });
    expect(data).toStrictEqual({ taskId: 'task-1', source: 'agent_inferred', epistemic: 'preference', observation: 'x' });
    expect(data).not.toHaveProperty('quote');
  });
});
