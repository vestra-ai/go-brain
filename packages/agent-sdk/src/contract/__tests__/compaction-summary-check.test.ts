/**
 * T9c fix round 3 — the summary checker, pinned against the REAL failure.
 *
 * The model judge in `scripts/compaction-eval` is a containment test over the whole
 * projection, and the D2 drill's own summary passes it: the instruction sits under
 * "## Latest request" while the Goal section still describes the task, so a judge asked
 * "does this document contain enough information?" answers YES. The failure that shipped
 * to a user was invisible to the gate built to catch it.
 *
 * The first leg below is the proof this checker can fail on the real thing: section 1 is
 * quoted VERBATIM from the recorded compaction summary of staging task fe222a7a
 * (gpt-5.6-luna, round 23) — the same bytes the drill journal holds.
 */
import { describe, it, expect } from 'vitest';
import {
  latestRequestSection,
  checkLatestRequest,
  LATEST_REQUEST_FORBIDDEN,
} from '../compaction-summary-check.js';

/** The ask that task was executing, tokens a correct section 1 would name. */
const D2_ASK_TOKENS = ['DONE 30', 'head -30', 'cat'];

/** VERBATIM from the drill's recorded summary — heading, curly quotes and all. */
const D2_RECORDED = `## Latest request

“Produce the structured summary of the conversation above now, using the section format from your instructions. Output only the summary.”

## Goal and intent

The original task was to use Bash only, with no browser or web access:

1. Run exactly:
   \`\`\`bash
   find /usr /opt /home -type f \\( -name '*.js' \\) -size +30k 2>/dev/null | head -30
   \`\`\`
2. Use one separate Bash tool call per discovered file.
3. Print each file with \`cat\` in full.
6. After all 30, reply exactly \`DONE 30\`.

## What happened

Files 1 through 23 were printed in full.`;

/** The same summary, hand-corrected: section 1 names the ask. Nothing else changed. */
const D2_CORRECTED = D2_RECORDED.replace(
  '“Produce the structured summary of the conversation above now, using the section format from your instructions. Output only the summary.”',
  'Print each of the 30 large files found by `find … | head -30` in full with `cat`, one Bash call per file, then reply exactly `DONE 30`. Still unfulfilled — 23 of 30 printed.',
);

describe('latestRequestSection — the new "Open request" label and the legacy one', () => {
  // finding 7 (2026-09-02): the schema's section 1 is now "Open request". Journals written
  // before that carry "Latest request" — the D2 record below is one — so BOTH must parse.
  // Mutation: recognise only the new label → the D2 legs below fail on "no section" instead
  // of on the instruction it exists to catch; recognise only the old → the live prompt's
  // own output is invisible to the gate.
  it('extracts an ATX "Open request" section', () => {
    const summary = '## Open request\nreply DONE 30 once all files are printed\n\n## Goal and intent\nprint them';
    expect(latestRequestSection(summary)).toBe('reply DONE 30 once all files are printed');
    expect(checkLatestRequest(summary, { mustContain: D2_ASK_TOKENS }).ok).toBe(true);
  });

  it('extracts the schema\'s own numbered "1. Open request — …" form with the content on the line', () => {
    const summary = '1. Open request — read the routes\n2. Goal and intent — migration status';
    expect(latestRequestSection(summary)).toBe('read the routes');
  });

  it('an "Open request" section still ends at a legacy-labelled next section, and vice versa', () => {
    expect(latestRequestSection('## Open request\nA\n\n## Latest request\nB')).toBe('A');
    expect(latestRequestSection('## Latest request\nB\n\n## Open request\nA')).toBe('B');
  });

  it('a summary with neither label has no section', () => {
    expect(latestRequestSection('## Goal and intent\nmigration status')).toBeNull();
    expect(checkLatestRequest('## Goal and intent\nx', { mustContain: [] }).reasons[0]).toContain('Open request');
  });
});

describe('latestRequestSection — the section, not the document', () => {
  it('extracts an ATX-heading section and stops at the next heading', () => {
    const section = latestRequestSection(D2_RECORDED)!;
    expect(section).toContain('Produce the structured summary');
    // It STOPS: the Goal section's text must not bleed in, or every check below would
    // be reading the whole document again and the section scoping would buy nothing.
    expect(section).not.toContain('The original task was to use Bash only');
  });

  it('extracts a bold-heading section — the form claude-haiku-4-5 actually emits', () => {
    const summary = '**Latest request**\nread every file under apps/server/src/routes\n\n**Goal and intent**\nmigration status';
    expect(latestRequestSection(summary)).toBe('read every file under apps/server/src/routes');
  });

  it('extracts a numbered-list section — the schema\'s own form', () => {
    const summary = '1. Latest request — read the routes\n2. Goal and intent — migration status';
    // The label and its separator are consumed; the content on the same line is kept.
    expect(latestRequestSection(summary)).toBe('read the routes');
  });

  it('returns null when there is no such section', () => {
    expect(latestRequestSection('just some prose about what happened')).toBeNull();
  });
});

describe('checkLatestRequest — it FAILS on the drill\'s real summary', () => {
  it('the recorded D2 summary FAILS: section 1 is the summarizer\'s own instruction', () => {
    // THE POSITIVE CONTROL. Without this leg the checker could be inert and every green
    // run would mean nothing.
    const verdict = checkLatestRequest(D2_RECORDED, { mustContain: D2_ASK_TOKENS });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('structured summary');
    expect(verdict.reasons.join(' ')).toContain('section format');
    // …and it also notices the ask is missing from the section, not just that the
    // instruction is present.
    expect(verdict.reasons.some((r) => r.includes("names none of the ask's tokens"))).toBe(true);
  });

  it('the hand-corrected twin PASSES — only section 1 differs', () => {
    const verdict = checkLatestRequest(D2_CORRECTED, { mustContain: D2_ASK_TOKENS });
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('a missing section 1 is a FAILURE, never a silent pass', () => {
    const verdict = checkLatestRequest('## Goal and intent\nsomething', { mustContain: D2_ASK_TOKENS });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain('no "Open request"');
  });

  it('the ask tokens are OR — one is enough, because summaries paraphrase', () => {
    const summary = '## Latest request\nfinish printing the files and reply DONE 30\n\n## Next step\ncontinue';
    expect(checkLatestRequest(summary, { mustContain: D2_ASK_TOKENS }).ok).toBe(true);
  });

  it('the forbidden phrases are scoped to the SECTION — elsewhere is fine', () => {
    // "What happened" may legitimately mention that a summary was produced. Only
    // section 1 — the thing the resuming model reads as its objective — is constrained.
    const summary =
      '## Latest request\nreply DONE 30 once all files are printed\n\n' +
      '## What happened\nA structured summary was produced at round 23.';
    expect(checkLatestRequest(summary, { mustContain: D2_ASK_TOKENS }).ok).toBe(true);
  });

  it('an empty mustContain still enforces the forbidden set — the "None" case', () => {
    // A compaction whose cut RETAINS the ask correctly writes "None" under section 1
    // (COMPACTION_SYSTEM: "Write \"None\" only if the last exchange was fully resolved").
    // There is no ask token to look for there, but the instruction must still be absent.
    expect(checkLatestRequest('## Latest request\nNone\n\n## Next step\ngo', { mustContain: [] }).ok).toBe(true);
    expect(
      checkLatestRequest('## Latest request\nProduce the structured summary\n\n## Next step\ngo', {
        mustContain: [],
      }).ok,
    ).toBe(false);
  });

  it('every forbidden phrase is individually detected', () => {
    // Or the set would be decoration: one dead entry and nobody would know.
    for (const phrase of LATEST_REQUEST_FORBIDDEN) {
      const summary = `## Latest request\nDONE 30 — but also ${phrase}\n\n## Next step\ngo`;
      const verdict = checkLatestRequest(summary, { mustContain: D2_ASK_TOKENS });
      expect(verdict.ok, `"${phrase}" was not detected`).toBe(false);
    }
  });
});

// ─── S7 / S8: heading forms, and where a section actually ends ────────────────

describe('S7 — legitimate heading forms are not false-failed', () => {
  const cases: Array<[string, string]> = [
    ['bold with a colon inside', '**Latest request:**\nreply DONE 30 when every file is printed'],
    ['bold with a colon outside', '**Latest request**:\nreply DONE 30 when every file is printed'],
    ['plain line with a colon', 'Latest request:\nreply DONE 30 when every file is printed'],
    ['ATX with a paren-numbered label', '## 1) Latest request\nreply DONE 30 when every file is printed'],
    ['ATX with a dot-numbered label', '## 1. Latest request\nreply DONE 30 when every file is printed'],
    ['numbered plain', '1) Latest request — reply DONE 30 when every file is printed'],
    ['ATX, content on the heading line', '## Latest request: reply DONE 30 when every file is printed'],
  ];

  for (const [name, summary] of cases) {
    it(`accepts ${name}`, () => {
      // A checker that cannot find the section returns "no Latest request section" — a
      // FAILURE. Rejecting a legitimate rendering would fail a correct summary, which is
      // worse than useless: it trains everyone to ignore the gate.
      const verdict = checkLatestRequest(`${summary}\n\n## Next step\ncontinue`, {
        mustContain: D2_ASK_TOKENS,
      });
      expect(verdict.section, name).not.toBeNull();
      expect(verdict.ok, `${name}: ${verdict.reasons.join('; ')}`).toBe(true);
    });
  }

  it('does NOT match the phrase in running prose', () => {
    // The anchor is a line start with optional markup, so a sentence mentioning the
    // phrase is not mistaken for the section heading.
    expect(latestRequestSection('The latest request was handled already.')).toBeNull();
    expect(latestRequestSection('Latest requests are tracked in the ledger.')).toBeNull();
  });
});

describe('S8 — a list or a bold lead-in inside section 1 does not truncate it', () => {
  it('a numbered list inside the section keeps the whole section', () => {
    // The old NEXT_SECTION matched `\d+\.\s+[A-Z]` anywhere, so a summary that spelled
    // the ask out as steps was cut off after its first line — and the ask token, which
    // usually lands in the steps, went missing. That reads as a mis-attributed section
    // when the summary was in fact correct.
    const summary = [
      '## Latest request',
      '',
      'The user asked to:',
      '1. Run the find command',
      '2. Print each file with cat',
      '3. Reply exactly DONE 30',
      '',
      '## Goal and intent',
      'Audit large files.',
    ].join('\n');
    const section = latestRequestSection(summary)!;
    expect(section).toContain('DONE 30');
    expect(section).not.toContain('Audit large files');
    expect(checkLatestRequest(summary, { mustContain: D2_ASK_TOKENS }).ok).toBe(true);
  });

  it('a bold lead-in inside the section keeps the whole section', () => {
    const summary = [
      '## Latest request',
      '',
      '**Still unfulfilled.** Print the remaining files and reply DONE 30.',
      '',
      '## Next step',
      'continue at file 24',
    ].join('\n');
    const section = latestRequestSection(summary)!;
    expect(section).toContain('DONE 30');
    expect(section).not.toContain('continue at file 24');
  });

  it('a BOLD-headed summary still ends at the next bold section, not at EOF', () => {
    // Ending only at `## ` would swallow the rest of a bold-rendered summary, and the
    // forbidden set — which is scoped to section 1 on purpose — would start firing on
    // "What happened".
    const summary = [
      '**Latest request**',
      'reply DONE 30 when every file is printed',
      '',
      '**What happened**',
      'A structured summary was produced at round 23.',
    ].join('\n');
    const section = latestRequestSection(summary)!;
    expect(section).toBe('reply DONE 30 when every file is printed');
    expect(checkLatestRequest(summary, { mustContain: D2_ASK_TOKENS }).ok).toBe(true);
  });
});
