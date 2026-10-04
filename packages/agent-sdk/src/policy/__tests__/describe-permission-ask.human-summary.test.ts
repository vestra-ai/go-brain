/**
 * The permission card's summary must read as a human sentence for EVERY
 * side-effect family — never a token lifted out of the script the agent ran.
 *
 * Live incident (staging interaction 527e0f4c, task c479, 2026-08-09): a
 * delete-gated Bash script opened with `set -euo pipefail`, the analyzer could
 * not enumerate it, and the describer fell back to the raw first token. The
 * founder was shown "Run set" and had to guess what he was approving.
 *
 * Founder ruling: users are non-technical; a permission ask must say what will
 * happen in plain words. The GUARD is unchanged by these tests (same tools
 * gated, same families, same floor) — only the words.
 */
import { describe, it, expect } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { describePermissionAsk } from '../describe-tool.js';
import type { SideEffectFamily } from '../side-effect-classifier.js';

const call = (toolName: string, toolInput: unknown = {}): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 't1',
});
const bash = (command: string): ToolCall => call('Bash', { command });

/**
 * The VERBATIM command from staging interaction 527e0f4c (task c479): a
 * `set -euo pipefail` preamble, a python heredoc, and two `curl -X DELETE`
 * calls. Kept byte-for-byte so the regression pin tracks the real shape.
 */
const C479_COMMAND = [
  'set -euo pipefail',
  "python3 - <<'PY'",
  'import base64,json',
  "p='/app/workspace/files/AR/AgentRamp-Invoice-Second-Tranche-2026-06-24.pdf'",
  "content=base64.b64encode(open(p,'rb').read()).decode()",
  "open('/tmp/create-final.json','w').write(json.dumps({'filename':'AgentRamp-Invoice-Second-Tranche-2026-06-24.pdf','content':content,'mimeType':'application/pdf','folderId':'50c0243f-f9a7-476f-805f-a086c4ef1229'}))",
  'PY',
  'curl -s -X POST -H "Authorization: Bearer $VESTRA_API_TOKEN" -H \'Content-Type: application/json\' "$VESTRA_SERVER_URL/api/files/create-file" --data-binary @/tmp/create-final.json | tee /tmp/final.json | jq .',
  "old='9fe7f2e6-3958-49ae-804f-befe2245740f'",
  "test='beeda9d1-7529-4da3-acfa-7dc0253cfefc'",
  'curl -s -X DELETE -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/files/$old" | jq .',
  'curl -s -X DELETE -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/files/$test" | jq .',
  'curl -s -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/files?search=AgentRamp-Invoice" | jq \'{files:[.files[]|{id,filename,folderId,mimeType,sizeBytes}]}\'',
].join('\n');

describe('permission summary — the c479 regression', () => {
  const ask = describePermissionAsk(bash(C479_COMMAND), {
    family: 'dangerous_delete',
    floor: 'hard',
    level: 'relaxed',
  });

  it('says what the ask is about instead of the script\'s first token', () => {
    expect(ask.headline).toBe('Delete files in your workspace');
  });

  it('never shows the raw "Run set" the founder was shown', () => {
    expect(ask.headline).not.toBe('Run set');
  });

  it('leaves the guard rail exactly as it was (button, note, why-line)', () => {
    expect(ask.actionLabel).toBe('Delete files');
    expect(ask.details).toEqual([
      { label: 'Note', value: 'This cannot be undone.', tone: 'danger' },
    ]);
    expect(ask.reasonLine).toBe(
      'Deletions always check with you. Only Autopilot runs them alone.',
    );
  });
});

describe('permission summary — one human template per family', () => {
  // An opaque script: the analyzer cannot enumerate it and its first token is a
  // shell builtin, so NOTHING about the call can be put into words. Every family
  // must still produce a sentence a non-technical user understands.
  const opaque = bash("set -euo pipefail\nold='x'\nsome_helper");

  const templates: Array<[SideEffectFamily, string]> = [
    ['readonly', 'Read files in your workspace'],
    ['workspace_write', 'Update files in your workspace'],
    ['dangerous_delete', 'Delete files in your workspace'],
    ['external_send', 'Send a message'],
    ['external_mutation', 'Make a change in a connected app'],
    ['payment', 'Approve a payment'],
  ];

  for (const [family, expected] of templates) {
    it(`${family} reads "${expected}"`, () => {
      const ask = describePermissionAsk(opaque, { family, floor: 'rule' });
      expect(ask.headline).toBe(expected);
    });
  }

  it('no family ever lets the script text become the summary', () => {
    for (const [family] of templates) {
      const ask = describePermissionAsk(bash(C479_COMMAND), { family, floor: 'rule' });
      expect(ask.headline).not.toMatch(/^Run \w+$/);
      expect(ask.headline).not.toContain('set');
      expect(ask.headline).not.toContain('curl');
      expect(ask.headline).not.toContain('$');
    }
  });
});

describe('permission summary — a delete names what it removes', () => {
  const headline = (command: string): string =>
    describePermissionAsk(bash(command), {
      family: 'dangerous_delete',
      floor: 'hard',
      level: 'relaxed',
    }).headline;

  it('names both files of a two-file delete', () => {
    expect(headline('rm /app/workspace/files/a.pdf /app/workspace/files/b.pdf')).toBe(
      'Delete 2 files: a.pdf, b.pdf',
    );
  });

  it('names a single file directly', () => {
    expect(headline('rm scratch.txt')).toBe('Delete scratch.txt');
  });

  it('lists the first three and counts the rest', () => {
    expect(headline('rm a.pdf b.pdf c.pdf d.pdf e.pdf')).toBe(
      'Delete 5 files: a.pdf, b.pdf, c.pdf and 2 more',
    );
  });

  it('keeps the pattern wording for a glob delete', () => {
    expect(headline('rm *.md')).toBe('Delete files matching *.md');
  });

  it('still says a recursive delete takes everything inside', () => {
    expect(headline('rm -rf build/')).toBe('Delete build/ and everything inside');
  });
});

describe('permission summary — a documented command is not a described one', () => {
  it('does not read a heredoc BODY as the command being run', () => {
    // The body is data written to a file, never executed — the guard strips
    // heredoc bodies before judging, and the words must agree with the guard.
    const ask = describePermissionAsk(
      bash("cat > notes.md <<'EOF'\nRun rm -rf build to start over\nEOF"),
      { family: 'workspace_write', floor: 'rule' },
    );
    expect(ask.headline).not.toContain('delete');
    expect(ask.headline).not.toContain('Delete');
  });
});
