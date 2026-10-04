/**
 * Bootstrap-baseline tool descriptions (K5-T0).
 *
 * PROVENANCE: the file/shell/web/task tool descriptions are bootstrapped from the
 * licensed @anthropic-ai/claude-code CLI top-level tool prose (locked decision 4),
 * cross-checked against @anthropic-ai/claude-agent-sdk/sdk-tools.d.ts param docs.
 * Vestra-original tools (Skill, search_abilities, context_query, remember) keep
 * our own prose — they have no SDK counterpart. This is a licensed-source bootstrap, not
 * a permanent verbatim copy: descriptions are refined to Vestra voice on a tracked
 * cadence, guarded by the abilities/compaction eval harness once funded. The first
 * pass ran 2026-09-02 (sprint 2.06a): Bash, Read, Write, Edit, Glob, Grep and
 * ExitPlanMode now speak the soul's register for a non-technical product — each says
 * when to reach for it and names its nearest neighbour — and carry none of the
 * coding-agent assumptions the bootstrap brought ("ready to code", "never create
 * documentation files", "for searching code"). The original extraction is still
 * regenerable with `node apps/sandbox/scripts/extract-claude-code-tool-prose.mjs`;
 * diff it, do not paste it back.
 *
 * Keys are the canonical wire tool NAMES — they double as the registry cross-check
 * in tools/index.ts.
 */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash:
    'Run a shell command in the workspace and get back what it printed. This is the primitive ' +
    'work you do directly: convert or extract a file, run a script, install a tool, check your ' +
    'output. Give a short `description` in active voice; `timeout` (ms, max 600000) bounds a ' +
    'long command. For something that should keep running (a server, a long job) set ' +
    '`run_in_background: true`: you get a `task_id` at once and read, feed or stop it with the ' +
    'process tool. Very large output is capped (head and tail kept); for all of it, re-run with ' +
    '`> out.txt 2>&1` and Read that file with `offset`/`limit`. To find files or search inside ' +
    'them use Glob and Grep, not find/grep/cat/head/tail: faster, and they skip ignored files.',
  Read:
    'Read a file from the workspace: text as numbered lines; an image (PNG, JPEG, GIF, WEBP) as ' +
    'the image itself, so you can see it. Use `offset` and `limit` only for a file too big to ' +
    'read in one go: a partial read ends with the shown range and the next `offset`, so a ' +
    'cut-off view is never mistaken for the whole file, and a file over the size limit must be ' +
    'read that way or searched with Grep. A PDF cannot be read directly: extract its text or ' +
    'turn its pages into images first (via Bash), then Read that. To find the file, use Glob (by ' +
    'name) or Grep (by content).',
  Write:
    'Create a file, or replace one, with the content you pass; folders are made as needed. For a ' +
    'file you produce from scratch: a document the person keeps (it reaches them as a preview ' +
    'chip), or a script. To change part of an existing file, use Edit. A structured deliverable ' +
    '(report, brief, deck, plan) comes from its skill, not Write.',
  Edit:
    'Change part of an existing file by replacing an exact string. Read the file first (again if ' +
    'it changed since) or the edit is refused. `old_string` must match exactly, whitespace ' +
    'included, and appear once; `replace_all: true` changes every occurrence; `new_string` must ' +
    'differ. For a new file or a full rewrite use Write; for many changes across files in one ' +
    'go, use Patch.',
  Patch:
    'Apply a structured multi-file patch in ONE call (the V4A apply-patch envelope). Prefer this ' +
    'over many Edit calls when changing several files or several locations at once. The `input` is ' +
    '`*** Begin Patch` … `*** End Patch` with `*** Update File: <p>`, `*** Add File: <p>`, ' +
    '`*** Delete File: <p>`, and `*** Move File: <src> -> <dst>` sections; Update hunks use ` ` ' +
    '(context), `-` (remove), `+` (add) line prefixes with an optional `@@ context hint @@`. ' +
    'All-or-nothing: if any hunk cannot be located (or any path is blocked) NO files are changed.',
  Glob:
    'Find files by name or path pattern, ignored files skipped; returns a sorted list of paths ' +
    '("**/*.pdf", "reports/**/*.md"). Pass `path` only to look inside one folder, else leave it ' +
    'out entirely (never "undefined" or "null"). To find files by content use Grep; to read one, ' +
    'use Read.',
  Grep:
    'Search inside files by content with a regular expression (scope with `path`): where a word ' +
    'or phrase appears in any file. To find files by name, use Glob. Narrow with `glob` or ' +
    '`type`; `output_mode` is "files_with_matches" (default), "content" or "count"; ' +
    '`-A`/`-B`/`-C`/`context` add context lines, `-n` line numbers, `-i` ignores case, `-o` ' +
    'gives only the match, `multiline` spans lines, `head_limit`/`offset` page. A capped result ' +
    'ends with the shown range and the next `offset`. Faster than grep via Bash, and skips ' +
    'ignored files.',
  WebFetch:
    'Fetch a specific web page or text/JSON URL and return its readable content. ' +
    'The optional `prompt` is advisory: it is prepended to the result to guide your reading, ' +
    'not applied server-side. Use when you already have a URL and need to read what is on it. ' +
    'For discovering pages, use WebSearch instead.',
  WebSearch:
    'Search the web and return results. Useful for current events and recent information beyond the ' +
    'knowledge cutoff. Restrict or exclude sources with `allowed_domains` / `blocked_domains`. ' +
    'Searches run server-side; cite the returned sources.',
  AskUserQuestion:
    'Ask the user 1-4 multiple-choice questions and pause for their answer. Use when a decision ' +
    'genuinely needs the user (an ambiguous requirement, a fork in the approach, a preference) — ' +
    'NOT for things you can determine yourself. The user answers by CLICKING: this is the ' +
    'preferred way to ask anything frameable as choices, including yes/no and confirm/decline. ' +
    'Each question has a short `header` chip, a clear `question`, and 2-4 distinct `options` ' +
    '(label + description); set `multiSelect: true` when choices are not mutually exclusive. ' +
    'An "Other" free-text option is added automatically as the LAST option — never author one.',
  ExitPlanMode:
    'Only in plan mode, once your plan is laid out: it asks the person to approve moving from ' +
    'read-only planning to doing the work, whatever the work is (a document, an email, research, ' +
    'file changes). If the plan or an explanation is itself the answer, just give it. Pass the ' +
    '`plan` (concise; markdown works); on approval, plan mode ends and you act. To ask a ' +
    'question instead, use AskUserQuestion.',
  Monitor:
    'Run a `command` and surface each new stdout/stderr line LIVE as it arrives, for the duration ' +
    'of this turn. Use to tail a log, watch a build/test run, or follow a long process and react to ' +
    'its output as it streams. Provide a clear, concise `description`. The watch ends after ' +
    '`timeout_ms` (default 300000, max 3600000) or when the process exits. Set `persistent: true` ' +
    'for a long-lived process that should outlive this turn: it detaches — starts the command in ' +
    'the background and returns its bg_ id immediately (no live streaming); poll its accumulated ' +
    'output in later turns with TaskOutput, stop it with TaskStop. To poll an already-backgrounded ' +
    'command\'s accumulated output instead, use TaskOutput. Stop a watched process early with TaskStop.',
  TodoCreate:
    'Create and track a to-do item in the user\'s task list. This IS your built-in to-do / checklist ' +
    '/ progress tool — ALWAYS use it for anything to-do related, INCLUDING to-dos the user asks you ' +
    'to make AND your own progress steps before a multi-step task. Do NOT use an external to-do app ' +
    '(Todoist, Asana, Notion) unless the user names that specific app.',
  TodoUpdate:
    'Advance a tracked todo (status: "in_progress" | "completed" | "deleted"). You can also revise ' +
    'subject/description/activeForm/owner, attach metadata (set a key to null to delete it), and ' +
    'declare dependencies with addBlocks / addBlockedBy.',
  TodoGet: 'Get a single tracked todo by its taskId (id, subject, description, status, activeForm).',
  TodoList: 'List every tracked todo for this session with its current status.',
  process:
    'Manage a background job started by Bash(run_in_background:true). action: ' +
    '"read" (paged output via offset/limit, block+timeout to wait for exit), ' +
    '"list" (all running jobs), "write" (raw stdin), "submit" (stdin + Enter - answer a prompt), ' +
    '"close" (EOF), "kill". Requires id for every action except list.',
  TaskOutput:
    'Retrieve accumulated output from a background task by `task_id`. Set `block: true` to wait for ' +
    'the process to finish (up to `timeout` ms); `block: false` returns whatever output has ' +
    'accumulated so far without waiting. (DEPRECATED - use process({action:"read"|"kill"}))',
  TaskStop: 'Stop a running background task by `task_id`. Kills the process and frees its slot. (DEPRECATED - use process({action:"read"|"kill"}))',
  Skill:
    'Load and run an installed skill by its slug, then follow its SKILL.md. For ANY deliverable an ' +
    'installed skill produces — a report, brief, deck, document, research synthesis, spec — you MUST ' +
    'invoke the matching skill FIRST and follow it, instead of hand-writing the file with Write. ' +
    'Skills are grouped under their ability; pick the one whose domain matches the task.',
  search_abilities:
    'Search the Vestra Abilities catalog for relevant abilities by description, name, or tags. Use ' +
    'when the user asks "do you have X?" or attempts a task outside your active capabilities. ' +
    'Returns up to 3 ranked results.',
  context_query:
    'Search the user\'s memory for what matters to a topic: their pages, notes and proof. ' +
    'Returns the matching items (on the brain arm, as files to open with Read) or an empty ' +
    'string when nothing matches. Omit the query for the map of what is stored.',
  // Nami P1 first-hand memory. This prose is THE quality lever: it decides what
  // the agent deposits. DO: durable facts about the USER's world. DON'T: task
  // mechanics or anything about the agent itself. Registered only under
  // NAMI_FIRSTHAND (see buildNativeToolList), so flag-OFF catalogs never carry it.
  remember:
    'Save a durable fact about the user\'s world to long-term memory the moment you learn it, ' +
    'so it is never lost. Be generous: if a fact about the user could still matter to them weeks ' +
    'from now, save it. ' +
    'Worth saving: who they are (their role, where they are, the tools and services they use); ' +
    'the people and organizations in their world and how they relate to them (a colleague, an ' +
    'investor they email, a client, a company they work with); what they are working on or ' +
    'deciding; commitments and deadlines they take on; preferences and how they like to work; ' +
    'decisions they make; and corrections to something you previously believed. ' +
    // THE GROUNDING LESSON (2026-08-22): the agent had emailed a summary three times
    // because three tasks told it to, and that became a standing rule in the user's
    // procedures file. What the agent did is evidence about the agent, never the person.
    'What you did yourself is never evidence of what the user wants: an instruction in one ' +
    'task is that task, not a standing preference, so do not save it as one. ' +
    'Write each as one plain sentence in your own words, concrete enough to be useful months ' +
    'later: keep names, dates, and numbers. One call per fact. ' +
    'Do NOT save task mechanics, transient steps, or anything about yourself or how you did ' +
    'the work.',
};
