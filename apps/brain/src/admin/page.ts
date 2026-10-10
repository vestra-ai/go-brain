// The admin page: one screen for the operator at the side of the stage. Plain HTML forms and no script, light and
// readable on a laptop. Everything shown is escaped, and phone numbers are masked.
import type { RecipeStat } from '../travel/book/engine.js';
import type { TripWatches } from '../travel/recipe-watches.js';
import type { ProbeResult } from './health.js';
import type { SwitchName } from './switches.js';

export interface AdminView {
  tripId: string | null;
  /** This Go: the stage (brain), the rehearsal Go or the try-room Go; null when it cannot tell. */
  role: 'stage' | 'rehearsal' | 'try' | null;
  /** The newest trips, for the trip picker. */
  trips: string[];
  at: Date;
  health: ProbeResult[];
  switches: Array<{ name: SwitchName; value: string }>;
  /** The chosen trip's people, when Go can read them; otherwise the watch form takes a person id. */
  people: Array<{ id: string; name: string }>;
  /** deployed is false while P6's calls lane is not on this Go yet. */
  calls: { mode: string; deployed: boolean; allowlist: Array<{ name: string | null; masked: string }> };
  note: string | null;
  docsUrl: string;
  /** How fast each ixigo recipe answers, at each speed, since Go started. */
  recipes: RecipeStat[];
  /** The watches groups asked for that are going, per trip. */
  watches?: TripWatches[];
}

export const SWITCH_CHOICES: Record<SwitchName, Array<{ value: string; label: string }>> = {
  TRAVEL_MODE: [{ value: 'ixigo', label: 'ixigo' }, { value: 'ixigo_web', label: 'ixigo_web (ixigo.com, link only)' }, { value: 'fake', label: 'fake (test inventory)' }],
  TRAVEL_RUNNER: [{ value: 'agent_job', label: "agent_job (a job on the trip's computer)" }, { value: 'browser_fetch', label: "browser_fetch (Bash's browser fetch)" }],
  PAY_RAIL: [{ value: 'ixigo', label: 'ixigo' }, { value: 'stripe_test', label: 'stripe_test (test card)' }, { value: 'fake', label: 'fake (no charge)' }],
  CALLS_MODE: [{ value: 'off', label: 'off' }, { value: 'allowlist', label: 'allowlist' }],
  REFLEX_LIVE: [
    { value: 'off', label: 'off (no quick read)' },
    { value: '', label: 'none live, all watching' },
    { value: 'q1,q2,q3', label: 'q1,q2,q3' },
    { value: 'q1,q2,q3,q8', label: 'q1,q2,q3,q8' },
    { value: 'q1,q2,q4,q5,q6,q7,q8,q10,q11', label: 'the ones that passed (q11 actionable included)' },
    { value: 'q1,q2,q3,q4,q5,q6,q7,q8,q9,q10,q11', label: 'all eleven' },
  ],
  BROWSER_FETCH_SLOTS: [{ value: '2', label: '2 (Bash runs two at once)' }, { value: '4', label: '4 (Bash runs four at once)' }, { value: '1', label: '1 (one page at a time)' }],
  RECIPE_WATCHES: [{ value: 'off', label: 'off' }, { value: 'on', label: 'on (Go keeps the watches groups ask for)' }],
  BOOKING: [{ value: 'off', label: 'off (Book it opens ixigo; a stay is booked as before)' }, { value: 'on', label: "on (Go books flights and stays on ixigo's pages, up to Pay)" }],
};

export const SWITCH_MEANING: Record<SwitchName, string> = {
  TRAVEL_MODE: "Where flights and stays come from. ixigo_web reads ixigo.com in the trip's browser, and people book there. fake is our test inventory: say so on stage.",
  TRAVEL_RUNNER: "How Go reads ixigo.com. browser_fetch takes about 4 s and needs Bash's browser fetch; agent_job takes 12 to 18 s.",
  PAY_RAIL: 'How a payment is charged. stripe_test charges a test card; fake charges nothing.',
  CALLS_MODE: 'Whether Go may phone anyone. allowlist means only the numbers listed under Calls.',
  REFLEX_LIVE: 'Which quick-read questions act live; the others only watch. off stops the quick read altogether.',
  BROWSER_FETCH_SLOTS: "How many ixigo pages Go opens at once on a trip's computer. Match Bash's own cap: more than it runs wait their turn.",
  RECIPE_WATCHES: 'Whether Go keeps an eye on ixigo when a group asks ("tell us when it confirms"): a page an hour a watch, three watches a trip at most.',
  BOOKING: "Whether Go books on ixigo's own pages, on the stage, up to ixigo's pay button: a person's own flight from Book it, and the group's voted stay from Yes, book it. off: a flight's Book it opens ixigo. instances:a,b turns it on only for trips from those Server instances.",
};

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ROLE_LINE: Record<'stage' | 'rehearsal' | 'try' | 'unknown', string> = {
  stage: 'This is the stage Go.',
  rehearsal: 'This is the rehearsal Go.',
  try: 'This is the try-room Go, where visitors chat with Go.',
  unknown: 'This Go does not say which it is: set GO_ROLE.',
};

const DOT_WORD: Record<ProbeResult['dot'], string> = { green: 'OK', amber: 'Slow or waking', red: 'Down' };

const CSS = `
:root{--ink:#0A0A0A;--muted:#5F5F5F;--line:#ECEAE6;--soft:#F7F6F3;--green:#1F8A4C;--amber:#A86500;--red:#C0362C;--accent:#EEF0FF}
*{box-sizing:border-box}
body{margin:0;background:#FFFFFF;color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 24px 48px}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-0.01em}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:32px 0 10px}
p{color:var(--muted);margin:4px 0}
.note{background:var(--accent);color:var(--ink);border-radius:12px;padding:10px 14px;margin:16px 0}
table{width:100%;border-collapse:collapse}
td{padding:10px 8px;border-top:1px solid var(--line);vertical-align:middle}
td.num{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%}
.dot.green{background:var(--green)}.dot.amber{background:var(--amber)}.dot.red{background:var(--red)}
.row{display:grid;grid-template-columns:1fr 130px 210px 90px;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.row p{font-size:14px}
.now{font-weight:600}
select,input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#FFFFFF;color:var(--ink);width:100%}
label{display:block;font-size:14px;color:var(--muted)}
button{font:inherit;font-weight:600;padding:9px 14px;border:0;border-radius:10px;background:var(--ink);color:#FFFFFF;cursor:pointer}
button.quiet{background:#FFFFFF;color:var(--ink);border:1px solid var(--line)}
.card{background:var(--soft);border-radius:16px;padding:16px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0}
.pick{display:flex;gap:8px;max-width:520px;margin-top:12px}
.warn{color:var(--red);font-weight:600}
footer{margin-top:36px;display:flex;gap:18px;align-items:center}
a{color:var(--ink)}
`;

/** A link that keeps the chosen trip. Never the token: the session cookie signs every request in. */
function link(path: string, v: AdminView, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ ...(v.tripId ? { trip: v.tripId } : {}), ...extra });
  const query = q.toString();
  return query ? `${path}?${query}` : path;
}

function switchRow(v: AdminView, s: { name: SwitchName; value: string }): string {
  const listed = SWITCH_CHOICES[s.name];
  const choices = listed.some((c) => c.value === s.value) ? listed : [...listed, { value: s.value, label: s.value }];
  const options = choices
    .map((c) => `<option value="${esc(c.value)}"${c.value === s.value ? ' selected' : ''}>${esc(c.label)}</option>`)
    .join('');
  return `<form class="row" method="post" action="${esc(link('/admin/switches', v))}">
<div><b>${s.name}</b><p>${esc(SWITCH_MEANING[s.name])}</p></div>
<div class="now">${esc(s.value || 'none')}</div>
<input type="hidden" name="name" value="${s.name}"><select name="value" aria-label="${s.name}">${options}</select>
<button>Save</button></form>`;
}

function callsBlock(v: AdminView): string {
  if (!v.calls.deployed) return '<p>Calls are not deployed on this Go yet, so Go cannot phone anyone.</p>';
  const listed = v.calls.allowlist.map((c) => `${esc(c.name ?? 'No name')} (${esc(c.masked)})`).join(', ');
  if (v.calls.mode === 'allowlist' && v.calls.allowlist.length === 0) {
    return '<p class="warn">CALLS_ALLOWLIST is empty, so Go will refuse every call. Add the villa number before the call beat.</p>';
  }
  if (v.calls.mode === 'allowlist') return `<p>Calls go only to: ${listed}.</p>`;
  return `<p>Calls are off. Switch CALLS_MODE to allowlist for the call beat.${listed ? ` The list has: ${listed}.` : ''}</p>`;
}

function actionsBlock(v: AdminView): string {
  if (v.tripId === null) return '<p>Pick a trip above to use these.</p>';
  const trip = `<input type="hidden" name="trip_id" value="${esc(v.tripId)}">`;
  const person = v.people.length > 0
    ? `<select name="person_id">${v.people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`
    : '<input name="person_id" placeholder="p_arjun" required>';
  return `<div class="card"><b>Fire a watch</b>
<p>A flight delay for one person. Go's notice says "Simulated for the demo", and the presenter says so too. "Now lands at" is in the trip's own time; with it, the notice says when they land and moves what the note times around it.</p>
<form method="post" action="${esc(link('/admin/fire-watch', v))}">${trip}
<div class="grid">
<label>Person ${person}</label>
<label>Flight <input name="label" value="IndiGo 6E 2134"></label>
<label>Late by, minutes <input name="delay_minutes" value="120" inputmode="numeric"></label>
<label>Now lands at <input type="datetime-local" name="lands_at"></label>
<label>Note <input name="note" placeholder="The airport cab is booked for 9 pm"></label>
</div><button>Fire a watch</button></form></div>
<div class="card"><b>Between rehearsals</b>
<form method="post" action="${esc(link('/admin/stop-jobs', v))}">${trip}<button class="quiet">Stop all running jobs for this trip</button></form>
<p></p>
<form method="post" action="${esc(link('/admin/decline-pay', v))}">${trip}<button class="quiet">Decline the waiting pay card</button></form>
<p></p>
<form method="post" action="${esc(link('/admin/check-computer', v))}">${trip}<button class="quiet">Check this trip's computer (wakes it)</button></form></div>`;
}

/** Each ixigo recipe's numbers: the middle and slow end of its last runs, at each speed, and how many failed. */
function recipesBlock(recipes: RecipeStat[]): string {
  if (recipes.length === 0) return '<p>No recipe has run since Go started.</p>';
  const ms = (n: number | null): string => (n === null ? 'none yet' : `${n} ms`);
  const rows = recipes
    .map((r) => `<tr><td>${esc(r.recipe)}</td><td>${esc(r.speed)}</td><td class="num">${ms(r.p50_ms)}</td><td class="num">${ms(r.p90_ms)}</td><td class="num">${r.runs}</td><td class="num">${r.failed}</td></tr>`)
    .join('\n');
  return `<table><tr><th>Recipe</th><th>Speed</th><th>p50</th><th>p90</th><th>Runs</th><th>Failed</th></tr>\n${rows}</table>`;
}

/** The watches groups asked Go to keep on ixigo: per trip, how many are going and when the next is checked (IST). */
function watchesBlock(watches: TripWatches[]): string {
  if (watches.length === 0) return '<p>No watch is going.</p>';
  const at = (iso: string): string => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const rows = watches.map((w) => `<tr><td>${esc(w.trip_id)}</td><td class="num">${w.active}</td><td>${esc(at(w.next_check_at))}</td></tr>`).join('\n');
  return `<table><tr><th>Trip</th><th>Watches</th><th>Next check</th></tr>\n${rows}</table>`;
}

export function renderAdminPage(v: AdminView): string {
  const time = v.at.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  const health = v.health
    .map((h) => `<tr><td><span class="dot ${h.dot}" title="${DOT_WORD[h.dot]}"></span></td><td>${esc(h.label)}</td><td>${esc(h.detail)}</td><td class="num">${h.ms} ms</td></tr>`)
    .join('\n');
  const trips = v.trips.map((t) => `<option value="${esc(t)}"></option>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Go: stage desk</title>
<style>${CSS}</style></head>
<body><main>
<h1>Go: stage desk</h1>
<p>${ROLE_LINE[v.role ?? 'unknown']} Trip <b>${esc(v.tripId ?? 'none chosen')}</b>. Checked at ${esc(time)}.</p>
<form class="pick" method="get" action="/admin">
<input name="trip" list="trips" value="${esc(v.tripId ?? '')}" placeholder="trip id" aria-label="trip id"><datalist id="trips">${trips}</datalist>
<button class="quiet">Check this trip</button></form>
${v.note ? `<p class="note">${esc(v.note)}</p>` : ''}
<h2>Health</h2>
<table>${health}</table>
<p>Each check waits at most 1.5 s. Reload the page to check again.</p>
<h2>Recipes</h2>
${recipesBlock(v.recipes)}
<h2>Watches</h2>
${watchesBlock(v.watches ?? [])}
<h2>Switches</h2>
${v.switches.map((s) => switchRow(v, s)).join('\n')}
<div class="row"><div><b>DEMO_ROOM</b><p>Which room is on stage: the App on the phones, or the dev room (pnpm --filter @go/sim room). Chosen on the laptop, not in Go.</p></div><div class="now">on the laptop</div><div></div><div></div></div>
<p>Anything simulated is said out loud on stage.</p>
<h2>Calls</h2>
${callsBlock(v)}
<h2>Stage actions</h2>
${actionsBlock(v)}
<footer><a href="/board">Proof board</a><a href="${esc(v.docsUrl)}" rel="noreferrer">Docs</a><a href="${esc(link('/admin/health.json', v))}">health.json</a>
<form method="post" action="/admin/sign-out"><button class="quiet">Sign out</button></form></footer>
</main></body></html>`;
}
