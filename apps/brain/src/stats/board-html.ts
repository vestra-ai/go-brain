/** The proof board page for the stage: big numbers, the bar under each, honest labels. */
import type { BoardNumbers } from './stats.js';

/** The bars from spec §1. */
export const BARS = { typingMs: 500, replyP50Ms: 2500, replyP90Ms: 5000, cacheHit: 0.85, wakeRate: 0.25 } as const;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const seconds = (ms: number | null): string | null => (ms === null ? null : ms < 100 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const pct = (x: number | null): string | null => (x === null ? null : `${Math.round(x * 100)}%`);
const usd = (x: number | null): string | null => (x === null ? null : `$${x < 1 ? x.toFixed(3) : x.toFixed(2)}`);

type Mark = 'good' | 'bad' | 'none';
interface Tile { label: string; value: string; detail: string; bar: string; mark: Mark }

function tileHtml(t: Tile, k: number): string {
  const numeric = /^\$?[\d.,]+\s?(%|s|ms)?$/.test(t.value);
  return `<section class="tile t${k % 5}"><div class="label"><span class="dot ${t.mark}"></span>${esc(t.label)}</div>`
    + `<div class="big${numeric ? '' : ' words'}">${esc(t.value)}</div><div class="detail">${esc(t.detail)}</div>`
    + `${t.bar === '' ? '' : `<div class="bar">${esc(t.bar)}</div>`}</section>`;
}

/** ", build at 1a2b3c4": where the bench ran. The model it judged is kept in the summary but never shown on the board. */
function ranFrom(summary: Record<string, unknown>): string {
  const branch = typeof summary['branch'] === 'string' ? summary['branch'] : null;
  const commit = typeof summary['commit'] === 'string' ? summary['commit'].slice(0, 7) : null;
  if (branch === null && commit === null) return '';
  return `, ${[branch, commit === null ? null : `at ${commit}`].filter((x) => x !== null).join(' ')}`;
}

function benchLine(summary: Record<string, unknown>): string {
  const n = (k: string): number | null => (typeof summary[k] === 'number' && Number.isFinite(summary[k]) ? (summary[k] as number) : null);
  const recall = summary['recall'] as { passed?: unknown; probes?: unknown } | undefined;
  const parts: string[] = [];
  if (n('messages') !== null) parts.push(`${n('messages')} messages`);
  parts.push(summary['cacheStatus'] === 'not_cacheable_yet' ? 'cache not cacheable yet' : `cache ${pct(n('cacheHit')) ?? 'no data'}`);
  if (n('wakeRate') !== null) parts.push(`woke the model for ${pct(n('wakeRate'))}`);
  if (typeof recall?.passed === 'number' && typeof recall.probes === 'number' && recall.probes > 0) parts.push(`recall ${recall.passed} of ${recall.probes}`);
  if (n('replyP50Ms') !== null) parts.push(`reply p50 ${seconds(n('replyP50Ms'))}`);
  return parts.join(', ');
}

export function renderTiles(n: BoardNumbers): string {
  const when = n.window.hours === 1 ? 'the last hour' : `the last ${n.window.hours} hours`;
  const val = (s: string | null): string => s ?? (n.empty ? 'No turns yet' : 'No data yet');
  const updated = new Date(n.window.to).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const tiles: Tile[] = [
    {
      label: 'Go is typing',
      value: val(seconds(n.typing.p50Ms)),
      detail: n.typing.n === 0 ? 'from a message that names Go to "Go is typing"' : `p50 from the message landing; p90 ${seconds(n.typing.p90Ms) ?? 'no data'}, over ${n.typing.n} turns`,
      bar: 'Bar: under 0.5 s',
      mark: n.typing.p90Ms === null ? 'none' : n.typing.p90Ms < BARS.typingMs ? 'good' : 'bad',
    },
    {
      label: 'Reply',
      value: val(seconds(n.reply.p50Ms)),
      detail: n.reply.n === 0 ? "from the message to Go's answer" : `p50 from the message landing; p90 ${seconds(n.reply.p90Ms) ?? 'no data'}, over ${n.reply.n} answers`,
      bar: 'Bar: p50 under 2.5 s, p90 under 5 s',
      mark: n.reply.p50Ms === null || n.reply.p90Ms === null ? 'none' : n.reply.p50Ms < BARS.replyP50Ms && n.reply.p90Ms < BARS.replyP90Ms ? 'good' : 'bad',
    },
    {
      label: 'Prompt cache',
      value: n.cache.status === 'not_cacheable_yet' ? 'Not cacheable yet' : val(pct(n.cache.hit)),
      detail: n.cache.status === 'not_cacheable_yet' ? 'every prompt so far is under the caching minimum' : n.cache.turns === 0 ? 'share of each prompt read from cache' : `of the prompt read from cache, over ${n.cache.turns} turns`,
      bar: 'Bar: 85% or more',
      mark: n.cache.hit === null ? 'none' : n.cache.hit >= BARS.cacheHit ? 'good' : 'bad',
    },
    {
      label: 'Woke the model',
      value: val(pct(n.wake.rate)),
      detail: n.wake.messages === 0 ? 'messages that needed Go to think' : `${n.wake.turns} of ${n.wake.messages} messages`,
      bar: 'Bar: under 25%',
      mark: n.wake.rate === null ? 'none' : n.wake.rate < BARS.wakeRate ? 'good' : 'bad',
    },
    {
      label: 'Cost per trip',
      value: val(usd(n.cost.perTripUsd)),
      detail: n.cost.trips === 0 ? 'model cost per active trip' : `${n.cost.trips} trips, ${usd(n.cost.totalUsd) ?? '$0'} in all`,
      bar: '',
      mark: 'none',
    },
    ...n.sources.map((s): Tile => ({
      label: s.label,
      value: s.value === null ? 'No data yet' : String(s.value),
      detail: [s.of === undefined ? '' : s.of === 0 ? 'Nothing to count yet.' : `Out of ${s.of}.`, s.note ?? ''].filter((x) => x !== '').join(' '),
      bar: s.good === 'zero' ? 'Bar: zero' : '',
      mark: s.value === null || s.good !== 'zero' ? 'none' : s.value === 0 ? 'good' : 'bad',
    })),
  ];
  const header = `<header><div class="eyebrow">Go, live numbers</div>`
    + `<h1>${n.empty ? `No turns yet in ${when}.` : `From ${when} of real turns.`}</h1>`
    + `<p class="sub">${n.empty ? "Numbers appear after Go's first turn." : `${n.turns} turns, ${n.messages} messages from people. Updated ${esc(updated)} IST.`}</p></header>`;
  const bench = n.bench.length === 0
    ? ''
    : `<section class="bench"><h2>From the replay bench</h2><ul>${n.bench.map((b) => `<li><strong>${esc(b.chat)}</strong> ${esc(benchLine(b.summary))}<span class="when">${esc(b.mode)} run, ${esc(b.receivedAt.slice(0, 16).replace('T', ' '))} UTC${esc(ranFrom(b.summary))}</span></li>`).join('')}</ul></section>`;
  return `${header}<div class="grid">${tiles.map(tileHtml).join('')}</div>${bench}`;
}

const STYLE = `
:root { --ink: #0A0A0A; --muted: #5C5C5C; --line: #EDEDED; --mint: #E3F6EA; --lilac: #EEE8FB; --sky: #E4F0FB; --butter: #FBF5DC; --peach: #FDECDF; --good: #1F9D57; --bad: #D9480F; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #FFFFFF; color: var(--ink); }
body { font-family: 'Satoshi', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 1280px; margin: 0 auto; padding: 56px 40px 24px; }
header { margin-bottom: 36px; }
.eyebrow { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
h1 { font-size: clamp(32px, 4vw, 52px); font-weight: 700; letter-spacing: -0.02em; margin: 10px 0 6px; }
.sub { color: var(--muted); font-size: 18px; margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
.tile { border-radius: 28px; padding: 28px 28px 24px; min-height: 230px; display: flex; flex-direction: column; }
.t0 { background: var(--mint); } .t1 { background: var(--lilac); } .t2 { background: var(--sky); } .t3 { background: var(--butter); } .t4 { background: var(--peach); }
.label { font-size: 17px; font-weight: 500; display: flex; align-items: center; gap: 10px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #C9C9C9; flex: none; }
.dot.good { background: var(--good); } .dot.bad { background: var(--bad); }
.big { font-size: clamp(48px, 6.5vw, 96px); font-weight: 900; letter-spacing: -0.04em; line-height: 1; margin: 22px 0 12px; font-variant-numeric: tabular-nums; }
.big.words { font-size: clamp(28px, 3.4vw, 44px); letter-spacing: -0.02em; }
.detail { font-size: 16px; color: var(--muted); }
.bar { margin-top: auto; padding-top: 14px; font-size: 14px; color: var(--muted); }
.bench { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 22px; }
.bench h2 { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
.bench ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; font-size: 18px; }
.bench strong { margin-right: 8px; }
.when { color: var(--muted); font-size: 15px; margin-left: 10px; }
.status { text-align: center; color: var(--muted); font-size: 14px; min-height: 20px; }
@media (max-width: 600px) { main { padding: 32px 16px; } .tile { min-height: 0; } }
`;

function shell(body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Go live numbers</title>'
    + '<link rel="preconnect" href="https://api.fontshare.com"><link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&amp;display=swap">'
    + `<style>${STYLE}</style></head><body>${body}</body></html>`;
}

/** The full page. Its script swaps in fresh tiles every 5 s and keeps the last good numbers if a read fails. */
export function renderBoardPage(n: BoardNumbers): string {
  const script = `<script>
(() => {
  const tiles = document.getElementById('tiles');
  const status = document.getElementById('status');
  async function refresh() {
    try {
      const res = await fetch('/board/tiles' + location.search, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      tiles.innerHTML = await res.text();
      status.textContent = '';
    } catch (e) {
      status.textContent = 'Reconnecting. These numbers are from the last good read.';
    }
  }
  setInterval(refresh, 5000);
})();
</script>`;
  return shell(`<main id="tiles">${renderTiles(n)}</main><p id="status" class="status" aria-live="polite"></p>${script}`);
}

export function renderClosedPage(status: number): string {
  const text = status === 503 ? 'The board is off.' : 'This board needs its full link.';
  return shell(`<main><header><div class="eyebrow">Go, live numbers</div><h1>${text}</h1></header></main>`);
}
