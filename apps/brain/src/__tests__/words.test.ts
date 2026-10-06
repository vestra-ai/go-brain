// What people read never holds an em dash, an en dash or the word "Claude". PEOPLE_READ is every module whose strings
// reach a person: in the room, in the App, on a phone call, on the vault's pages, the admin page, the proof board, the
// dev room or from the fake Go. Every string in each one is checked, read from its source, so a word inside a template
// or a function counts too. A new module whose words reach people joins the list.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** The repo root, from apps/brain/src/__tests__/. */
const ROOT = new URL('../../../../', import.meta.url);

const PEOPLE_READ: readonly string[] = [
  // Go, in the room and on its cards
  'apps/brain/src/composer/room-tools.ts', // the vote card
  'apps/brain/src/composer/speak.ts', // "Go is typing..."
  'apps/brain/src/composer/turn.ts', // the line Go posts when a turn fails
  'apps/brain/src/door/taps.ts', // a tap's toast
  'apps/brain/src/travel/cards.ts', // options cards
  'apps/brain/src/travel/taps.ts',
  'apps/brain/src/travel/votes.ts',
  'apps/brain/src/tasks/working-card.ts', // the working card
  'apps/brain/src/tasks/taps.ts',
  'apps/brain/src/money/cards.ts', // pay and ticket cards
  'apps/brain/src/money/taps.ts',
  'apps/brain/src/money/words.ts', // refusals and the money lines
  'apps/brain/src/proactive/notice-tools.ts', // notice cards
  'apps/brain/src/proactive/words.ts',
  'apps/brain/src/watches/admin.ts', // the simulated watch's label
  'apps/brain/src/calls/service.ts', // the call card, the call lines and the Stop toast
  'apps/brain/src/calls/realtime.ts', // what Go says on the phone
  // Go, in the App
  'apps/brain/src/memory/catch-up.ts', // catch-up for someone who was away
  'apps/brain/src/memory/people.ts', // "What Go knows about you" and "Forget me"
  // Go's own pages
  'apps/brain/src/admin/page.ts', // the stage desk
  'apps/brain/src/admin/register.ts',
  'apps/brain/src/stats/board-html.ts', // the proof board
  // The vault's pages
  'apps/vault/src/pages/words.ts',
  'apps/vault/src/pages/html.ts',
  'apps/vault/src/pages/routes.ts',
  'apps/vault/src/pages/assets.ts',
  // The dev room (the emergency stage) and the fake Go the App team builds against
  'packages/sim/src/dev-room/page.ts',
  'packages/sim/src/dev-room/serve.ts',
  'packages/sim/src/state/trip-state.ts',
  // The hosted "try Go" room a judge opens: the passcode page, the room's lines and refusals
  'packages/sim/src/try-room/gate.ts',
  'packages/sim/src/try-room/serve.ts',
  'packages/sim/src/try-room/words.ts',
  'apps/fake-go/src/behaviour.ts',
  'apps/fake-go/src/cards.ts',
];

const SLIPS = /[\u2014\u2013]|claude/i;

/** Every string literal and template piece in a source, as it reads at run time, with its line. Regexes are not strings. */
function stringsOf(fileName: string, source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ) {
      out.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

const slipsIn = (path: string): string[] =>
  stringsOf(path, readFileSync(new URL(path, ROOT), 'utf8'))
    .filter((s) => SLIPS.test(s.text))
    .map((s) => `${path}:${s.line} ${s.text}`);

describe('what people read', () => {
  it('finds a slip in any string or template piece, and not in a regex', () => {
    const src = [
      "const a = 'Villa Sol \u2014 3 nights';",
      'const b = `Booked ${what} by Claude`;',
      'const c = /\u2014|claude/i;',
      "const d = 'Check-in, 2 pm';",
    ].join('\n');
    expect(stringsOf('x.ts', src).filter((s) => SLIPS.test(s.text)).map((s) => s.line)).toEqual([1, 2]);
  });

  for (const path of PEOPLE_READ) {
    it(`${path} has no em dash, en dash or "Claude"`, () => {
      expect(slipsIn(path)).toEqual([]);
    });
  }
});
