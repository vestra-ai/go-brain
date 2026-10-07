/** The bench report: the full JSON, and a markdown summary for the CI job page. No em dashes, no NaN. */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { LiveRun, Verdict } from './compare.js';
import type { ChatScore } from './score.js';
import { fmtInt, fmtMs, fmtPct, percentile } from './stats-math.js';

export interface BenchReport {
  schema: 'go.bench-report/v1';
  mode: 'fast' | 'live';
  at: string;
  commit: string | null;
  scores: ChatScore[];
  live?: LiveRun[];
  pick?: { model: string; why: string } | null;
  /** What /stats.json said at the end of each fast replay, by chat. */
  boards?: Record<string, unknown>;
  verdict: Verdict;
}

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\n/g, ' ');

/** One table row per ask of a live run: where its reply time went (timings.ts). */
export function timingRows(x: LiveRun): string[] {
  return (x.asks ?? []).map((a) => {
    const tools = [...new Set(a.calls.flatMap((c) => c.toolsAfter))];
    const waited = a.waited === null ? 'n/a' : a.waited ? `yes (due at ${fmtMs(a.dueMs)})` : 'no';
    const calls = `${a.calls.length}${tools.length > 0 ? ` (${tools.join(', ')})` : ''}`;
    const reply = a.reply === undefined || a.reply === null ? 'n/a' : `${a.reply.chars} chars, ${a.reply.sentences} ${a.reply.sentences === 1 ? 'sentence' : 'sentences'}`;
    const tokens = a.reply?.outputTokens ?? null;
    return `| ${x.model} | ${a.line} | ${waited} | ${fmtMs(a.typingMs)} | ${fmtMs(a.turnStartMs)} | ${calls} | ${fmtMs(a.calls[0]?.firstWordMs ?? null)} | ${fmtMs(a.parts.modelMs)} | ${fmtMs(a.parts.betweenMs)} | ${fmtMs(a.parts.afterModelMs)} | ${fmtMs(a.postMs)} | ${reply} | ${tokens === null ? 'n/a' : fmtInt(tokens)} |`;
  });
}

/** One line per live run: the median answer to an ask, in characters, sentences and the writing call's output tokens. */
export function replyLengths(x: LiveRun): string | null {
  const replies = (x.asks ?? []).flatMap((a) => (a.reply ? [a.reply] : []));
  if (replies.length === 0) return null;
  const median = (xs: number[]): number => {
    const s = [...xs].sort((p, q) => p - q);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
  };
  const tokens = replies.flatMap((r) => (r.outputTokens === null ? [] : [r.outputTokens]));
  return `- ${x.model}, ${x.chat}: ${replies.length} ${replies.length === 1 ? 'answer' : 'answers'}, median ${median(replies.map((r) => r.chars))} characters, ${median(replies.map((r) => r.sentences))} sentences${tokens.length > 0 ? `, ${fmtInt(median(tokens))} output tokens` : ''}.`;
}

/** Half a second or more from the last call's end to the post: what the call asked for, and Go's writes after it. */
const SLOW_POST_MS = 500;

/** One line per ask whose post came slowly after the model's last call: the call's tools, and each write Go sent after it. */
export function slowPosts(x: LiveRun): string[] {
  return (x.asks ?? []).flatMap((a) => {
    const after = a.parts.afterModelMs;
    if (after === null || after < SLOW_POST_MS) return [];
    const tools = a.lastTools ?? [];
    const writes = (a.afterModel ?? []).map(
      (w) =>
        `${w.method} sent at ${fmtMs(w.sentMs)}, reached the simulator at ${w.arrivedMs.length > 0 ? w.arrivedMs.map(fmtMs).join(' and ') : 'no time'}, ` +
        `answered at ${fmtMs(w.answeredMs)}${w.attempts > 1 ? ` after ${w.attempts} attempts` : ''}${w.error ? ` (error: ${cell(w.error)})` : ''}`,
    );
    return [`- ${x.model}, ${x.chat}, ask ${a.line}: ${fmtMs(after)} from the last call to the post. The last call asked for ${tools.length > 0 ? tools.join(', ') : 'no tools'}. Go's writes after it: ${writes.length > 0 ? writes.join('; ') : 'none'}.`];
  });
}

/** One line per live run, from Go's own tables: what Jev answered, and what woke each model turn. */
export function whyWoke(x: LiveRun): string | null {
  if (x.jev === undefined) return null;
  const reads = x.jev.reads;
  const faults = new Map<string, number>();
  for (const r of reads) if (!r.ok) faults.set(r.fault ?? 'unknown', (faults.get(r.fault ?? 'unknown') ?? 0) + 1);
  const notForGo = reads.filter((r) => {
    const f = (r.acted as { forGo?: { sure?: unknown; value?: unknown } } | null)?.forGo;
    return f?.sure === true && f.value === false;
  }).length;
  const answered = reads.length - [...faults.values()].reduce((a, b) => a + b, 0);
  const kinds = new Map<string, number>();
  for (const t of x.jev.turns) {
    const k = [...new Set(t.wokeFor)].sort().join(' and ') || 'nothing';
    kinds.set(k, (kinds.get(k) ?? 0) + t.n);
  }
  const woke = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${fmtInt(n)}`).join(', ');
  const ms = reads.map((r) => r.totalMs);
  return (
    `- ${x.model} on ${x.chat}: Jev read ${fmtInt(reads.length)} messages and answered ${fmtInt(answered)}` +
    `${faults.size > 0 ? ` (not answered: ${[...faults].map(([k, n]) => `${k} ${fmtInt(n)}`).join(', ')})` : ''}, in ${fmtMs(percentile(ms, 50))} p50 and ${fmtMs(percentile(ms, 90))} p90;` +
    ` ${fmtInt(notForGo)} read sure not for Go. Model turns by what woke them: ${woke || 'none'}.`
  );
}

function chatSection(s: ChatScore): string[] {
  const c = s.cache.results;
  const out = [
    `## ${s.chat}${s.mode === 'live' ? ` (${s.composerModel})` : ''}`,
    '',
    `- Messages from people: ${s.messages.people} (${s.messages.edits} edits, ${s.messages.deletes} deletes, ${s.messages.reactions} reactions, ${s.messages.photos} photos). Reflex: ${s.reflexSource === 'labels' ? 'hand labels' : s.reflexSource === 'recorded' ? 'recorded Jev reads' : 'live Jev'}.`,
    `- Woke the model: ${s.wake.rate === null ? 'no messages from people' : `${s.wake.turns} times for ${s.wake.messages} messages (${fmtPct(s.wake.rate)})`}.`,
    `- Typing p50 / p90: ${fmtMs(s.typing.p50Ms)} / ${fmtMs(s.typing.p90Ms)} (${s.typing.n} lines named Go, ${s.typing.missing} missing, ${s.typing.withoutPost} typing with no post after it).`,
    `- ${s.mode === 'fast' ? "Go's own time to reply" : 'Reply'} p50 / p90: ${fmtMs(s.reply.p50Ms)} / ${fmtMs(s.reply.p90Ms)} (${s.reply.n} answers).`,
    `- Speaking: ${s.speak.asks} asks, ${s.speak.answered} answered; ${s.speak.posts} posts (prompted ${s.speak.byKind.prompted}, follow-up ${s.speak.byKind.follow_up}, greeting ${s.speak.byKind.greeting}, duplicate ${s.speak.byKind.duplicate}, unprompted ${s.speak.byKind.unprompted}).`,
    `- Quiet: ${s.quiet.reactions} reactions (${s.quiet.wrongReactions.length} where it was not fine), ${s.quiet.recordLines} record lines.`,
    `- Cache (estimate): ${s.cache.status === 'not_cacheable_yet' ? 'not cacheable yet' : `${fmtPct(s.cache.hitRate)} (with the first request ${fmtPct(s.cache.hitRateAll)})`} over ${s.cache.requests} composer requests. Hits ${c.hit}, first ${c.first}, below minimum ${c.below_minimum}, TTL ${c.ttl}, delete ${c.delete}, edit ${c.edit}, fold ${c.fold}, rules changed ${c.rules_changed}, drift ${c.drift}.`,
    `- Prompt: ${s.prompt.maxTokens === null ? 'no composer turns' : `largest ${fmtInt(s.prompt.maxTokens)} tokens, last ${fmtInt(s.prompt.lastTokens ?? 0)}`}${s.prompt.average === null ? '' : `; on average tools ${fmtInt(s.prompt.average.tools)}, system ${fmtInt(s.prompt.average.system)}, cached chat ${fmtInt(s.prompt.average.chat)}, after the cache point ${fmtInt(s.prompt.average.now)}`}.`,
    `- Folds: ${s.cache.folds.length === 0 ? 'none' : s.cache.folds.map((f) => `request ${f.n}, chat ${fmtInt(f.beforeChatTokens)} to ${fmtInt(f.afterChatTokens)} tokens`).join('; ')}.`,
    `- Recall: ${s.recall.probes === 0 ? 'no probes' : !s.recall.ran ? 'not run (the memory lane is not registered)' : `${s.recall.passed} of ${s.recall.probes} (${s.recall.afterFold} asked after a fold)`}.`,
    `- Deleted text in a later prompt: ${s.leaks.length === 0 ? 'none' : s.leaks.map((l) => `line ${l.line} in request ${l.requestN}`).join(', ')}.`,
    `- Side passes: ${s.side.requests} requests, ${fmtInt(s.side.tokens)} tokens. Cost${s.mode === 'fast' ? ' (priced from the estimate)' : ''}: ${s.costUsd === null ? 'n/a' : `$${s.costUsd.toFixed(4)}`}. First word p50: ${fmtMs(s.firstToken.p50Ms)}. Ran for ${fmtMs(s.durationMs)}.`,
  ];
  if (s.speak.missed.length > 0) out.push('', '**Missed asks**', '', ...s.speak.missed.map((m) => `- line ${m.line}: ${m.text}`));
  if (s.speak.unprompted.length > 0) out.push('', '**Unprompted posts (for review)**', '', ...s.speak.unprompted.slice(0, 20).map((u) => `- after line ${u.afterLine ?? 'none'}: ${u.text.slice(0, 160)}`));
  if (s.quiet.wrongReactions.length > 0) out.push('', '**Reactions where a quiet action was not fine**', '', ...s.quiet.wrongReactions.map((w) => `- line ${w.line}: ${w.emoji}`));
  if (s.recall.failed.length > 0) out.push('', '**Recall misses**', '', ...s.recall.failed.map((f) => `- "${f.question}" wanted message #${f.seq ?? 'unknown'} (line ${f.line}); got ${f.got.length === 0 ? 'nothing' : f.got.join(' / ')}`));
  const firsts = s.turns.filter((t) => t.firstRound).slice(0, 40);
  if (firsts.length > 0) {
    out.push('', '| Request | Chat time | Tokens | Read | Result | Same blocks |', '|---|---|---|---|---|---|');
    for (const t of firsts) out.push(`| ${t.n} | ${fmtInt(t.simS)} s | ${fmtInt(t.estimate.totalTokens)} | ${fmtInt(t.estimate.readTokens)} | ${t.result} | ${t.sharedBlocks} |`);
  }
  return out;
}

export function renderSummary(r: BenchReport): string {
  const failing = r.verdict.checks.filter((c) => !c.ok);
  const lines = [
    `# Go replay bench (${r.mode})`,
    '',
    failing.length === 0 ? `**All ${r.verdict.checks.length} checks pass.**` : `**${failing.length} of ${r.verdict.checks.length} checks fail.**`,
    '',
    `Commit ${r.commit ?? 'unknown'}, ${r.at}. ${r.mode === 'fast' ? 'The model is a scripted stand-in, so reply times are Go\'s own time. Cache numbers are estimates from the request bodies.' : 'Real models and real Jev; cache numbers are the provider\'s own.'}`,
    '',
  ];
  if (r.live !== undefined && r.live.length > 0) {
    lines.push('## Models', '', '| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const x of r.live) {
      const s = x.score;
      lines.push(`| ${x.model} | ${x.chat} | ${fmtMs(s.reply.p50Ms)} | ${fmtMs(s.reply.p90Ms)} | ${fmtMs(x.provider.firstTokenP50Ms)} | ${fmtMs(s.typing.p90Ms)} | ${fmtPct(x.provider.cacheHit)} | ${fmtPct(s.cache.hitRate)} | ${x.provider.costUsd === null ? 'n/a' : `$${x.provider.costUsd.toFixed(4)}`} | ${s.speak.missed.length + s.speak.unprompted.length + s.speak.duplicates.length} |`);
    }
    lines.push('', r.pick ? `**Suggested COMPOSER_MODEL: ${r.pick.model}.** It ${r.pick.why}.` : 'No model to suggest.', '');
    const why = r.live.map(whyWoke).filter((l): l is string => l !== null);
    if (why.length > 0) lines.push('## Why Go woke', '', ...why, '');
    const timed = r.live.flatMap(timingRows);
    if (timed.length > 0) {
      lines.push(
        '## Where reply time goes',
        '',
        'Per ask, in time after its last line reached the simulator: whether it waited for more lines, typing, the turn\'s start, the model calls (and the tools they asked for), the first call\'s first word, the time inside model calls, the time between them (the tools ran there), from the last call to the post, and the post.',
        '',
        '| Model | Ask (line) | Waited | Typing | Turn starts | Model calls | First word | In model calls | Between calls | Last call to post | Post | Reply | Output tokens |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
        ...timed,
        '',
      );
      const lengths = r.live.map(replyLengths).filter((l): l is string => l !== null);
      if (lengths.length > 0) lines.push('How long the answers were (the reply posted, and the output tokens of the call that wrote it):', '', ...lengths, '');
      const slow = r.live.flatMap(slowPosts);
      if (slow.length > 0) lines.push('Posts that came half a second or more after the last call (times after the ask\'s line):', '', ...slow, '');
    }
  }
  lines.push('## Checks', '', '| Chat | Check | Value | Bar | Result |', '|---|---|---|---|---|');
  for (const c of [...failing, ...r.verdict.checks.filter((x) => x.ok)]) {
    lines.push(`| ${cell(c.chat)} | ${cell(c.name)} | ${cell(c.value)} | ${cell(c.bar)} | ${c.ok ? 'pass' : '**FAIL**'}${c.note !== undefined ? ` (${cell(c.note)})` : ''} |`);
  }
  for (const s of r.scores) lines.push('', ...chatSection(s));
  return `${lines.join('\n')}\n`;
}

export function writeReport(r: BenchReport, outDir: URL, basename: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(new URL(`${basename}.json`, outDir), `${JSON.stringify(r, null, 1)}\n`);
  writeFileSync(new URL(`${basename}.md`, outDir), renderSummary(r));
}
