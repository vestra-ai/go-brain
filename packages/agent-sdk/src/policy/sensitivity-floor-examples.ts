/**
 * THE FLOOR'S RULES, WITH THEIR EXAMPLES (harness to nine, S5).
 *
 * Data only: sensitivityFloorAsks (sensitivity-floor.ts) never reads this table.
 * It lives beside the floor rather than inside it so the floor's file only ever
 * shrinks. The rule-examples test sends every example through the floor
 * (workspace and shell at /app/workspace), so an edit that changes a verdict
 * fails CI until its examples change on purpose.
 *
 * The keyed parts are keyed on the floor's own unions: a new BashDeleteShape or
 * a new asking ComposioVerdict fails to compile here until it has examples.
 * Only the rules the floor spells in code, not in a union, are a hand list.
 */

import type { ToolCall } from '../contract/harness.js';
import type { RuleExamples } from './security-patterns.js';
import type { BashDeleteShape, ComposioVerdict } from './sensitivity-floor.js';

/** A call as the gate receives it, less its id. */
export type FloorExample = Pick<ToolCall, 'toolName' | 'toolInput'>;

/** The Composio verdicts the floor asks on. */
export type FloorComposioVerdict = Extract<ComposioVerdict, 'payment' | 'dangerous_delete'>;

interface DescribedExamples {
  rule: string;
  examples: RuleExamples<FloorExample>;
}

export type FloorRule =
  | ({ kind: 'bash-shape'; shape: BashDeleteShape } & DescribedExamples)
  | ({ kind: 'composio-verdict'; verdict: FloorComposioVerdict } & DescribedExamples)
  | ({ kind: 'prose' } & DescribedExamples);

const bashCall = (command: string): FloorExample => ({ toolName: 'Bash', toolInput: { command } });
const toolCall = (toolName: string, toolInput: Record<string, unknown> = {}): FloorExample => ({ toolName, toolInput });
const composioCall = (slug: string): FloorExample => toolCall(`mcp__composio__${slug}`);
const patchCall = (...lines: string[]): FloorExample =>
  toolCall('Patch', { input: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') });

/** One entry per delete shape a shell position can carry (bashPositionDeleteShape). */
export const BASH_SHAPE_EXAMPLES: Record<BashDeleteShape, DescribedExamples> = {
  filesystem: {
    rule: 'A shell delete asks when it is recursive, a glob, or leaves the workspace; one named file in the workspace runs, unless behind a wrapper (sudo, xargs, env)',
    examples: {
      match: [bashCall('rm -rf scratch/'), bashCall('rm *.md'), bashCall('rm ../shared/notes.txt'), bashCall('sudo rm build.log')],
      noMatch: [bashCall('rm scratch.txt'), bashCall('rm -f /app/workspace/files/frame.png 2>/dev/null'), bashCall('echo perform')],
    },
  },
  http: {
    rule: 'An HTTP DELETE from the shell asks, however it is spelled',
    examples: {
      match: [bashCall('curl -sS -X DELETE "$VESTRA_SERVER_URL/api/files/abc"'),
        bashCall('curl --request=DELETE https://api.example.com/items/1'), bashCall('http DELETE api.example.com/items/1')],
      noMatch: [bashCall('curl -sS https://api.example.com/items'),
        bashCall('curl -sS -X POST https://api.example.com/items -d \'{"name":"x"}\'')],
    },
  },
  find: {
    rule: 'A find that deletes what it matches asks',
    examples: {
      match: [bashCall("find . -name '*.tmp' -delete"), bashCall('find dist -type f -exec rm {} +')],
      noMatch: [bashCall("find . -name '*.ts' -not -path './node_modules/*'"), bashCall('find . -type f -exec wc -l {} +')],
    },
  },
  'move-to-null': {
    rule: 'A move onto /dev/null asks',
    examples: {
      match: [bashCall('mv notes.txt /dev/null'), bashCall('mv -f old.log /dev/null 2>&1')],
      noMatch: [bashCall('mv draft.md final.md'), bashCall('cat build.log > /dev/null')],
    },
  },
};

/** One entry per Composio verdict the floor asks on (composioVerdict). */
export const COMPOSIO_VERDICT_EXAMPLES: Record<FloorComposioVerdict, DescribedExamples> = {
  payment: {
    rule: 'A Composio money movement asks: on a known payment app, or by its verb on any other',
    examples: {
      match: [composioCall('STRIPE_CREATE_CHARGE'), composioCall('PAYPAL_CREATE_PAYOUT')],
      noMatch: [composioCall('STRIPE_LIST_CHARGES'), composioCall('STRIPE_RETRIEVE_BALANCE')],
    },
  },
  dangerous_delete: {
    rule: 'A Composio delete on a code host, a cloud or any other app asks, by its verb',
    examples: {
      match: [composioCall('GITHUB_DELETE_A_REPOSITORY'), composioCall('AIRTABLE_DELETE_RECORD')],
      noMatch: [composioCall('GITHUB_CREATE_ISSUE'), composioCall('NOTION_UPDATE_PAGE')],
    },
  },
};

/** The rules the floor spells in code rather than in a union. */
export const FLOOR_PROSE_RULES: ReadonlyArray<DescribedExamples> = [
  { rule: 'A generic MCP tool asks by its payment or delete verb; a send or a read runs',
    examples: {
      match: [toolCall('mcp__bank__transfer_funds'), toolCall('mcp__db__delete_row')],
      noMatch: [toolCall('mcp__wallet__get_balance'), toolCall('mcp__server__publish')],
    } },
  { rule: 'A delete hidden behind a substitution or a variable asks',
    examples: {
      match: [bashCall('echo $(rm -rf scratch/)'), bashCall('$RM_CMD -rf /tmp/cache'), bashCall('eval "$(echo rm -rf ~)"')],
      noMatch: [bashCall('cat "$(ls "$DIR")"'), bashCall('jq -r .name package.json')],
    } },
  { rule: 'A git push that rewrites or deletes shared history asks (a force, a remote delete, --prune, --mirror), and so does a gh delete or a git command it cannot read; a branch push runs, and until the founder rules (spec Q2) so do a push to main and a merge',
    examples: {
      match: [bashCall('git push --force origin feature/x'), bashCall('git push origin :old-branch'), bashCall('git push --mirror origin'),
        bashCall('gh repo delete acme/old-site --yes'), bashCall('gh api -X DELETE repos/acme/site'), bashCall('git push origin "$BRANCH"')],
      noMatch: [bashCall('git push -u origin feature/x'), bashCall('git push origin main'), bashCall('gh pr merge 12 --squash'),
        bashCall('git status'), bashCall('gh pr view 12'), bashCall('gh api repos/acme/site/pulls')],
    } },
  { rule: 'A Patch that deletes or moves a file asks; one that adds or edits runs',
    examples: {
      match: [patchCall('*** Delete File: src/old.ts'), patchCall('*** Move File: src/a.ts -> src/b.ts')],
      noMatch: [patchCall('*** Update File: src/a.ts', '@@', '-const x = 1;', '+const x = 2;'),
        patchCall('*** Add File: src/b.ts', '+export const b = 1;')],
    } },
];

export const SENSITIVITY_FLOOR_RULES: ReadonlyArray<FloorRule> = [
  ...(Object.keys(BASH_SHAPE_EXAMPLES) as BashDeleteShape[])
    .map((shape): FloorRule => ({ kind: 'bash-shape', shape, ...BASH_SHAPE_EXAMPLES[shape] })),
  ...(Object.keys(COMPOSIO_VERDICT_EXAMPLES) as FloorComposioVerdict[])
    .map((verdict): FloorRule => ({ kind: 'composio-verdict', verdict, ...COMPOSIO_VERDICT_EXAMPLES[verdict] })),
  ...FLOOR_PROSE_RULES.map((r): FloorRule => ({ kind: 'prose', ...r })),
];

/**
 * THE RELAXED INVARIANT (never-break rail, item 8): at the Relaxed level a
 * permission card fires only for payments and destructive deletes. Founder,
 * 2026-07-15, verbatim: "in relaxed mode only and only deletes and payments need
 * permission nothing else." A force push and a remote branch delete are deletes
 * of shared history, so they are inside it (git-command-catalog); a push to main
 * and a merge are not, and run at Relaxed until he rules (spec question 2). The
 * rule-examples test sends these through decideToolGate at Relaxed, with the
 * access-level flag off and on.
 */
export const RELAXED_INVARIANT_EXAMPLES: RuleExamples<FloorExample> = {
  match: [
    toolCall('mcp__composio__STRIPE_CREATE_CHARGE', { amount: 5000, currency: 'usd', customer: 'cus_123' }),
    bashCall('rm -rf scratch/'),
    toolCall('mcp__composio__GITHUB_DELETE_A_REPOSITORY', { owner: 'acme', repo: 'old-site' }),
    bashCall('git push --force origin main'),
    bashCall('git push origin :old-branch'),
    bashCall('gh repo delete acme/old-site --yes'),
  ],
  noMatch: [
    toolCall('mcp__composio__GMAIL_FETCH_EMAILS', { query: 'from:alice newer_than:7d' }),
    toolCall('mcp__composio__SLACK_SEND_MESSAGE', { channel: '#general', text: 'Standup notes are up' }),
    toolCall('Write', { file_path: '/app/workspace/notes.md', content: '# Standup notes' }),
    bashCall('git push -u origin feature/signup-fix'),
  ],
};
