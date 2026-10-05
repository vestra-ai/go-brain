// The last frames both ways, for the Server team to read on the /frames page, with a problem row wherever an
// answer from the Server broke the contract or never came.
/** in: Server to Go. out: Go to Server. problem: what was wrong with the Server's answer. */
export type FrameDirection = 'in' | 'out' | 'problem';

const LABEL: Record<FrameDirection, string> = { in: 'Server to Go', out: 'Go to Server', problem: 'Problem' };

export interface FrameRecord {
  at: string;
  direction: FrameDirection;
  instance: string;
  text: string;
}

const MAX_TEXT = 8192;

export class FrameLog {
  private readonly items: FrameRecord[] = [];

  constructor(private readonly max = 200, private readonly now: () => Date = () => new Date()) {}

  add(direction: FrameDirection, instance: string, text: string): void {
    const cut = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} [cut at ${MAX_TEXT} characters]` : text;
    this.items.push({ at: this.now().toISOString(), direction, instance, text: cut });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  /** Newest first. */
  list(): FrameRecord[] {
    return [...this.items].reverse();
  }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderFrames(items: FrameRecord[]): string {
  const rows = items
    .map((f) => `<tr class="${f.direction}"><td>${esc(f.at.slice(11, 23))}</td><td>${LABEL[f.direction]}</td><td>${esc(f.instance)}</td><td><code>${esc(f.text)}</code></td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>The fake Go: frames</title>
<style>
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 4px; }
p { color: #475569; margin: 0 0 16px; }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); }
td { padding: 8px 12px; border-top: 1px solid #e2e8f0; vertical-align: top; font-size: 13px; }
td:nth-child(1), td:nth-child(2), td:nth-child(3) { white-space: nowrap; color: #475569; }
tr.in td:nth-child(2) { color: #0369a1; }
tr.out td:nth-child(2) { color: #15803d; }
tr.problem td { background: #fef2f2; }
tr.problem td:nth-child(2) { color: #b91c1c; font-weight: 600; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<h1>The fake Go: the last ${items.length} frames</h1>
<p>Newest first, both ways, times in UTC. A Problem row says what was wrong with an answer from the Server. The page refreshes every 3 seconds.</p>
<table>
${rows || '<tr><td colspan="4">No frames yet.</td></tr>'}
</table>
</body>
</html>`;
}
