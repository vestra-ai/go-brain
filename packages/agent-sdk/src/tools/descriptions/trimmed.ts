/**
 * TOOL_DESC_TRIM_V1 (harness to nine T3) — the trimmed text of the resident core's heaviest
 * tools. Every request carries the resident core, so its words are paid on every round.
 *
 * Each trim keeps what changes behaviour: when to reach for the tool and its nearest
 * neighbour, the safety lines, what each parameter means, and every format rule a card
 * depends on. It cuts what is said twice: a sentence a parameter already says, a ripgrep
 * or schema restatement, and doctrine the system prompt carries once (when to ask lives
 * in <asking>; when to delegate in the soul). The full text stays in TOOL_DESCRIPTIONS
 * and is what every flag-off build advertises, byte for byte.
 *
 * Parameter text is trimmed beside each tool's schema (grep-tool.ts, bash-tool.ts,
 * read-tool.ts here; ask-user-question-tool.ts, monitor-tool.ts, task-tools.ts and
 * agent-tool-copy.ts in apps/sandbox), read the same way: once, when the tool is built.
 */
import { toolDescLeanEnabled, toolDescTrimEnabled } from '../../policy/feature-flags.js';
import { TOOL_DESCRIPTIONS } from './index.js';

export const TRIMMED_TOOL_DESCRIPTIONS = {
  Bash:
    'Run a shell command in the workspace and get back what it printed: convert or extract a ' +
    'file, run a script, install a tool, check your output. For something that should keep ' +
    'running (a server, a long job) set `run_in_background: true`: you get a `task_id` at once ' +
    'and read, feed or stop it with the process tool. Very large output is capped (head and tail ' +
    'kept); for all of it, re-run with `> out.txt 2>&1` and Read that file with `offset`/`limit`. ' +
    'To find files or search inside them use Glob and Grep, not find/grep/cat/head/tail: faster, ' +
    'and they skip ignored files.',
  Read:
    'Read a file from the workspace: text as numbered lines; an image (PNG, JPEG, GIF, WEBP) as ' +
    'the image itself, so you can see it. A partial read ends with the shown range and the next ' +
    '`offset`; a file over the size limit must be read in parts or searched with Grep. A PDF ' +
    'cannot be read directly: extract its text or turn its pages into images first (via Bash), ' +
    'then Read that. To find the file, use Glob (by name) or Grep (by content).',
  Grep:
    'Search inside files by content with a regular expression: where a word or phrase appears. ' +
    'To find files by name, use Glob. Faster than grep in Bash, and skips ignored files. A capped ' +
    'result ends with the shown range and the next `offset`.',
  AskUserQuestion:
    'Ask the user 1-4 multiple-choice questions and pause for the answer, which they give by ' +
    'clicking. The way to ask anything you can frame as choices, yes/no and confirm included; not ' +
    'for what you can settle yourself. An "Other" free-text option is added automatically as the ' +
    'last option: never write one.',
  Monitor:
    'Run a `command` and surface each new stdout/stderr line live as it arrives, for this turn: ' +
    'tail a log, watch a build or test run, follow a long process and react as it streams. The ' +
    'watch ends at `timeout_ms` or when the process exits; stop it early with TaskStop. ' +
    '`persistent: true` detaches instead: the command starts in the background and its bg_ id ' +
    'returns at once, with no live lines; read its output in later turns with TaskOutput. For a ' +
    'command already in the background, use TaskOutput.',
  TodoUpdate: 'Advance a tracked todo\'s status, or revise its fields, metadata and dependencies.',
} as const;

export type TrimmedToolName = keyof typeof TRIMMED_TOOL_DESCRIPTIONS;

/**
 * TOOL_DESC_LEAN_V1 (harness to nine, T1b to 12K) — each text is TOOL_DESCRIPTIONS' own, with
 * only the sentence its parameters already say removed. Nothing else is reworded:
 *   - Grep: "Narrow with `glob` or `type`; `output_mode` is ...; `-A`/`-B`/`-C`/`context` add
 *     context lines, `-n` ..., `head_limit`/`offset` page." Each clause is its parameter's own
 *     text (grep-tool.ts). The Glob neighbour, the paging marker and "Faster than grep via
 *     Bash" stay, word for word.
 *   - Bash: "; `timeout` (ms, max 600000) bounds a long command": the `timeout` parameter says
 *     it ("Optional timeout in milliseconds (max 600000)"). "Give a short `description` in active
 *     voice" stays (it drives the step labels the person reads, web narration/stepLabel.ts), as do
 *     "This is the primitive work you do directly", the background loop, the output cap and the
 *     Glob/Grep rule, word for word.
 * Read's words are untouched (an "only" never goes, even where the description repeats it); it
 * loses only its zero-information bounds at conversion. TOOL_DESC_TRIM_V1, when on, wins.
 */
export const LEAN_TOOL_DESCRIPTIONS: Partial<Record<TrimmedToolName, string>> = {
  Bash:
    'Run a shell command in the workspace and get back what it printed. This is the primitive ' +
    'work you do directly: convert or extract a file, run a script, install a tool, check your ' +
    'output. Give a short `description` in active voice. For something that should keep running ' +
    '(a server, a long job) set `run_in_background: true`: you get a `task_id` at once and read, ' +
    'feed or stop it with the ' +
    'process tool. Very large output is capped (head and tail kept); for all of it, re-run with ' +
    '`> out.txt 2>&1` and Read that file with `offset`/`limit`. To find files or search inside ' +
    'them use Glob and Grep, not find/grep/cat/head/tail: faster, and they skip ignored files.',
  Grep:
    'Search inside files by content with a regular expression (scope with `path`): where a word ' +
    'or phrase appears in any file. To find files by name, use Glob. A capped result ends with ' +
    'the shown range and the next `offset`. Faster than grep via Bash, and skips ignored files.',
};

/**
 * The description a tool advertises, read when the tool is built: the trimmed text under
 * TOOL_DESC_TRIM_V1, else the lean text under TOOL_DESC_LEAN_V1 (where one exists), otherwise
 * TOOL_DESCRIPTIONS exactly.
 */
export function toolDescription(name: TrimmedToolName): string {
  if (toolDescTrimEnabled()) return TRIMMED_TOOL_DESCRIPTIONS[name];
  return (toolDescLeanEnabled() ? LEAN_TOOL_DESCRIPTIONS[name] : undefined) ?? TOOL_DESCRIPTIONS[name];
}
