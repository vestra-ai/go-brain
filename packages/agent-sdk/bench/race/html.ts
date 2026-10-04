/**
 * The race's summary page (mockups/harness-nine/race.html): one self-contained HTML file,
 * plain English first, then one table per dimension, the spot-check list and the method.
 * Designed by the taste skill's document rules (the reports skill): the answer in the first
 * screen, one accent, Geist, tabular figures only in table cells, no em or en dashes, no
 * script. Every sentence is computed from the report, so a real run regenerates the page.
 */
import type { RaceEngine } from './plan.js';
import type { EngineCell, EngineTotals, RaceReport } from './report.js';

const ENGINE_NAME: Record<RaceEngine, string> = { native: 'Native', claude_code: 'Claude Code' };
const MODEL_NAME: Record<string, string> = { 'claude-sonnet-5-5': 'Sonnet 5.5', 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash' };

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const secs = (ms: number | null): string => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const int = (x: number | null): string => (x === null ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const usd = (x: number | null): string => (x === null ? 'n/a' : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`);
const share = (p: number, n: number): string => (n === 0 ? 'none judged' : `${p} of ${n}`);
const modelName = (m: string): string => MODEL_NAME[m] ?? m;

/** "2.1x faster", "about the same", from two numbers where lower is better. */
export function compareLower(a: number | null, b: number | null): string {
  if (a === null || b === null || a <= 0 || b <= 0) return 'not comparable yet';
  const r = b / a;
  if (r >= 0.95 && r <= 1.05) return 'about the same';
  return r > 1 ? `${r.toFixed(1)}x lower` : `${(1 / r).toFixed(1)}x higher`;
}

/** The plain-English summary: a few sentences, every number from the report. */
export function summarySentences(r: RaceReport): string[] {
  const n = r.totals.native;
  const c = r.totals.claude_code;
  const out: string[] = [];
  const tasks = r.rows.length;
  if (n && c) {
    const h = r.headToHead!;
    out.push(
      `Both engines ran ${tasks} tasks on ${modelName(r.model)}. Native showed the first readable text sooner on ${h.firstVisibleMs.native} of them and Claude Code on ${h.firstVisibleMs.claude_code}; ` +
        `the median wait was ${secs(n.firstVisibleMsMedian)} against ${secs(c.firstVisibleMsMedian)}.`,
    );
    out.push(`Whole turns: a median ${secs(n.totalMsMedian)} on native and ${secs(c.totalMsMedian)} on Claude Code; native finished first on ${h.totalMs.native} tasks.`);
    out.push(`Quality: the blind judge passed ${share(n.passed, n.judged)} native runs and ${share(c.passed, c.judged)} Claude Code runs.`);
    out.push(
      `Cost at list price: ${usd(n.listUsd)} for every native run together and ${usd(c.listUsd)} for Claude Code. ` +
        'Claude Code ran on a Claude plan, so its figure is what the same tokens would cost on the API, not what was paid.',
    );
  } else {
    const [e, t] = (n ? ['native', n] : ['claude_code', c]) as [RaceEngine, EngineTotals];
    out.push(
      `Only the ${ENGINE_NAME[e]} engine ran here, on ${modelName(r.model)}, over ${tasks} tasks: this is a dry run of the race harness, not the race. ` +
        'The head-to-head needs both engines on Sonnet 5.5.',
    );
    out.push(`Median first readable text ${secs(t.firstVisibleMsMedian)}, median whole turn ${secs(t.totalMsMedian)}, ${usd(t.listUsd)} at list price for all runs.`);
    out.push(`The blind judge passed ${share(t.passed, t.judged)} runs.`);
  }
  const skipped = r.skipped.length;
  if (skipped) out.push(`${skipped} runs were skipped for a missing precondition; they are listed at the end and count as neither a pass nor a fail.`);
  return out;
}

function td(v: string, num = true): string {
  return `<td${num ? ' class="n"' : ''}>${esc(v)}</td>`;
}

function dimensionTable(r: RaceReport, cols: Array<{ head: string; pick: (c: EngineCell) => string }>): string {
  const head = r.engines.flatMap((e) => cols.map((c) => `<th class="n">${esc(`${c.head}, ${ENGINE_NAME[e]}`)}</th>`)).join('');
  const body = r.rows
    .map((row) => {
      const cells = r.engines.flatMap((e) => cols.map((c) => td(row.engines[e] ? c.pick(row.engines[e]!) : 'not run')));
      return `<tr><th scope="row">${esc(row.task)}</th>${cells.join('')}</tr>`;
    })
    .join('');
  return `<div class="scroll"><table><thead><tr><th>Task</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function successTable(r: RaceReport): string {
  const head = r.engines.map((e) => `<th class="n">${ENGINE_NAME[e]}</th>`).join('');
  const body = r.rows
    .map((row) => {
      const cells = r.engines.map((e) => {
        const c = row.engines[e];
        return td(c ? (c.judged ? `${c.passed} of ${c.judged}` : 'not judged') : 'not run');
      });
      return `<tr><th scope="row">${esc(row.task)}</th><td>${esc(row.category)}</td>${cells.join('')}</tr>`;
    })
    .join('');
  return `<div class="scroll"><table><thead><tr><th>Task</th><th>Kind</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function categoryBars(r: RaceReport): string {
  const cats = Object.keys(Object.values(r.totals)[0]?.byCategory ?? {});
  const rows = cats
    .map((cat) => {
      const bars = r.engines
        .map((e) => {
          const b = r.totals[e]!.byCategory[cat]!;
          const pct = b.judged ? Math.round((b.passed / b.judged) * 100) : 0;
          // The bar takes at most 70% of the row, so the label always fits beside it.
          return `<div class="bar ${e}"><span style="width:${Math.round(pct * 0.7)}%"></span><em>${ENGINE_NAME[e]}: ${b.judged ? `${b.passed} of ${b.judged}` : 'none judged'}</em></div>`;
        })
        .join('');
      return `<div class="cat"><strong>${esc(cat)}</strong>${bars}</div>`;
    })
    .join('');
  return `<figure class="cats">${rows}<figcaption>Runs the blind judge passed, by kind of task.</figcaption></figure>`;
}

function facts(r: RaceReport): string {
  const items: Array<[string, string]> = [];
  for (const e of r.engines) {
    const t = r.totals[e]!;
    items.push([`${ENGINE_NAME[e]}: tasks done`, share(t.passed, t.judged)]);
    items.push([`${ENGINE_NAME[e]}: median turn`, secs(t.totalMsMedian)]);
  }
  return `<dl class="facts">${items.slice(0, 4).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

function takeaway(r: RaceReport): string {
  const n = r.totals.native;
  const c = r.totals.claude_code;
  if (n && c) {
    return `Native's median turn is ${compareLower(n.totalMsMedian, c.totalMsMedian)} than Claude Code's, passing ${n.passed} runs to ${c.passed}.`;
  }
  return `A dry run of the harness on ${modelName(r.model)}. The race itself waits on two approvals.`;
}

export function renderRaceHtml(r: RaceReport): string {
  const both = r.engines.length === 2;
  const title = both ? `Native vs Claude Code on ${modelName(r.model)}` : `Race dry run on ${modelName(r.model)}`;
  const summary = summarySentences(r);
  const speedFigure = r.engines
    .map((e) => {
      const t = r.totals[e]!;
      return `<div class="${e}"><span>${ENGINE_NAME[e]}</span><b>${secs(t.firstVisibleMsMedian)}</b><small>first visible text</small><b>${secs(t.firstToolMsMedian)}</b><small>first tool</small><b>${secs(t.totalMsMedian)}</b><small>whole turn</small></div>`;
    })
    .join('');
  const money = r.engines
    .map((e) => {
      const t = r.totals[e]!;
      const ledger = e === 'native' && t.ledgerUsd !== null ? `<small>our ledger recorded ${usd(t.ledgerUsd)} before margin</small>` : e === 'claude_code' ? '<small>ran on a Claude plan; list price shown</small>' : '';
      return `<div class="${e}"><span>${ENGINE_NAME[e]}</span><b>${usd(t.listUsd)}</b>${ledger}</div>`;
    })
    .join('');
  const spot = r.spotCheck
    .map((s) => {
      const runs = s.runs.map((x) => `${ENGINE_NAME[x.engine]} run ${x.run}: <code>${esc(x.taskId)}</code> (${x.pass === null ? 'not judged' : x.pass ? 'passed' : 'failed'})`).join('<br>');
      return `<li><strong>${esc(s.task)}</strong> <span class="muted">${esc(s.category)}, ${esc(s.why)}</span><div class="runs">${runs}</div></li>`;
    })
    .join('');
  const skipped = r.skipped.length
    ? `<section><h2>Skipped runs</h2><ul class="plain">${r.skipped.map((s) => `<li>${esc(s.task)} on ${ENGINE_NAME[s.engine]}, run ${s.run}: ${esc(s.reason)}</li>`).join('')}</ul></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(takeaway(r))}">
<meta name="theme-color" content="#f7f7f6">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root{--ground:#f7f7f6;--ink:#1c1c1f;--muted:#5d5d66;--line:#e2e2e5;--accent:#0b7a57;--other:#8a8a94}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.6 Geist,system-ui,sans-serif}
main{max-width:1080px;margin:0 auto;padding:56px 24px 96px}
h1{font-size:clamp(32px,5vw,52px);line-height:1.08;letter-spacing:-0.02em;font-weight:600;margin:0 0 16px;max-width:18ch}
h2{font-size:24px;letter-spacing:-0.01em;font-weight:600;margin:0 0 12px}
p{max-width:68ch;margin:0 0 12px}
.lede{font-size:20px;color:var(--muted);max-width:52ch;margin-bottom:32px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:24px;margin:0 0 8px}
.facts div{border-top:2px solid var(--ink);padding-top:10px}
.facts dt{color:var(--muted);font-size:14px}
.facts dd{margin:0;font-size:30px;font-weight:600;letter-spacing:-0.01em}
section{margin-top:72px}
.prose p{font-size:18px}
.speed{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:32px;margin:20px 0 28px}
.speed div,.money div{display:grid;grid-template-columns:auto 1fr;column-gap:12px;align-items:baseline}
.speed span,.money span{grid-column:1/-1;font-weight:600;margin-bottom:6px}
.speed b,.money b{font-size:28px;font-weight:600}
.speed small,.money small{color:var(--muted);font-size:14px}
.native span:first-child{color:var(--accent)}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:40px;align-items:start}
.money{display:flex;gap:56px;flex-wrap:wrap;margin:16px 0 28px}
.money div{display:flex;flex-direction:column}
.scroll{overflow-x:auto;border-top:1px solid var(--line)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:8px 12px 8px 0;vertical-align:top}
thead th{color:var(--muted);font-weight:500;border-bottom:1px solid var(--line);white-space:nowrap}
tbody th{font-weight:500;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:nth-child(even){background:rgba(28,28,31,0.025)}
.cats{margin:20px 0 28px}
.cat{display:grid;grid-template-columns:120px 1fr 1fr;gap:16px;align-items:center;padding:6px 0}
.bar{display:flex;align-items:center;gap:10px}
.bar span{display:block;flex:none;height:14px;min-width:2px;background:var(--other);border-radius:2px}
.bar.native span{background:var(--accent)}
.bar em{font-style:normal;font-size:13px;color:var(--muted);white-space:nowrap}
figcaption{color:var(--muted);font-size:14px;margin-top:8px}
ol.spot{padding-left:20px;max-width:80ch}
ol.spot li{margin-bottom:14px}
.runs{font-size:14px;color:var(--muted)}
.muted{color:var(--muted)}
code{font-family:'Geist Mono',ui-monospace,monospace;font-size:13px}
dl.method{display:grid;grid-template-columns:minmax(140px,220px) 1fr;gap:10px 32px;max-width:900px}
dl.method dt{font-weight:600}
dl.method dd{margin:0;color:var(--muted)}
ul.plain{padding-left:20px}
@media (max-width:760px){main{padding:32px 16px 64px}.split,dl.method{grid-template-columns:1fr}.cat{grid-template-columns:1fr}.money{gap:28px}}
</style>
</head>
<body>
<main>
<header>
<h1>${esc(title)}</h1>
<p class="lede">${esc(takeaway(r))}</p>
${facts(r)}
</header>

<section class="prose">
<h2>What it says</h2>
${summary.map((s) => `<p>${esc(s)}</p>`).join('\n')}
</section>

<section>
<h2>Speed</h2>
<p>Measured on the socket the web app listens to, from the moment the message was sent. First visible text is streamed text or a tool card's narration line, whichever the person could read first; streamed text alone is beside it. A follow-up task is timed on its question, not on reading the handbook.</p>
<div class="speed">${speedFigure}</div>
${dimensionTable(r, [
  { head: 'First visible', pick: (c) => secs(c.firstVisibleMs) },
  { head: 'Streamed text', pick: (c) => secs(c.firstTextMs) },
  { head: 'First tool', pick: (c) => secs(c.firstToolMs) },
  { head: 'Whole turn', pick: (c) => secs(c.totalMs) },
])}
</section>

<section class="split">
<div>
<h2>Model calls</h2>
<p>How many times each engine called the model for the whole task, as the engine reported it at the end of each turn. Fewer calls usually means less waiting.</p>
</div>
${dimensionTable(r, [{ head: 'Calls', pick: (c) => int(c.modelCalls) }])}
</section>

<section>
<h2>Tokens</h2>
<p>Uncached input, cached input and output for the whole task, from the server's own turn rows. Cached input costs a fraction of fresh input, so a high cached share is cheap.</p>
${dimensionTable(r, [
  { head: 'Input', pick: (c) => int(c.inputTokens) },
  { head: 'Cached', pick: (c) => int(c.cachedTokens) },
  { head: 'Output', pick: (c) => int(c.outputTokens) },
])}
</section>

<section>
<h2>Dollars</h2>
<p>Every run's tokens priced at the model's list price by the same pricer billing uses.</p>
<div class="money">${money}</div>
${dimensionTable(r, [{ head: 'List price', pick: (c) => usd(c.listUsd) }])}
</section>

<section>
<h2>Success</h2>
<p>A run passes when the blind judge marks every rubric line met and the facts the task asked for are in the reply. The rubrics were written before anything ran.</p>
${categoryBars(r)}
${successTable(r)}
</section>

<section>
<h2>Check these ten by hand</h2>
<p>Open each in the staging app and read the transcript. The list puts disagreements first.</p>
<ol class="spot">${spot}</ol>
</section>

<section>
<h2>How it was run</h2>
<dl class="method">
<dt>Model</dt><dd>${esc(modelName(r.model))} on every engine that ran.</dd>
<dt>Where</dt><dd>${esc(r.where)}, started ${esc(r.startedAt)}.</dd>
<dt>Order</dt><dd>Each run shuffles the tasks and flips which engine goes first, from seed ${r.seed}.</dd>
<dt>Judge</dt><dd>${esc(r.judgeModel ? modelName(r.judgeModel) : 'not run')}, never an Anthropic model. It sees the messages, tool calls and replies with tool names normalised, never the engine, the model, the times or the cost. Style can still hint at the engine; the hand checks cover that.</dd>
<dt>Dollars</dt><dd>List price for both engines from the same pricer. Native's ledger figure is shown beside it. Claude Code runs on the person's Claude plan.</dd>
</dl>
</section>
${skipped}
</main>
</body>
</html>
`;
}
