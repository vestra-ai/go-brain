// The live rehearsal, on brain-rehearsal only. The secrets come from the environment, never the command line (it lands
// in shell history and the process list): export GO_REHEARSAL_URL, GO_SIGNING_SECRET and GO_ADMIN_TOKEN (and GO_STAGE_URL,
// so a full run can refuse the stage Go) from the team's env file, then, from the repo root:
//   pnpm --filter @go/bench rehearse
// The stage Go, before the demo: one health read for the real trip, and nothing else (GO_STAGE_URL and GO_ADMIN_TOKEN set):
//   pnpm --filter @go/bench rehearse -- --warm --trip <real trip id>
// Exit 0: every beat passed (warm: no red probe). 1: a beat missed (warm: a red probe). 2: refused before it started.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseRehearseArgs, RefusedError, rehearse, type RehearseOptions } from '../src/rehearsal/run.js';
import { formatSheet, logLine, passed } from '../src/rehearsal/sheet.js';

async function main(): Promise<number> {
  let opts: RehearseOptions;
  try {
    opts = parseRehearseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  try {
    const out = await rehearse(opts);
    if (out.warmed) {
      const red = out.health.probes.filter((p) => p.dot === 'red').map((p) => p.label);
      console.log(red.length === 0 ? 'Warm: every probe answered.' : `Warm: red for ${red.join(', ')}.`);
      return red.length === 0 ? 0 : 1;
    }
    const at = new Date();
    const sheet = formatSheet(out.runs, { go: opts.go, tripId: out.tripId, at });
    console.log(`\n${sheet}\n`);
    console.log("For the run sheet's rehearsal log (fill in the run number and the fixes):");
    console.log(logLine(out.runs, { run: '?', date: at.toISOString().slice(0, 10) }));
    const dir = new URL('../out/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`rehearsal-${out.tripId ?? 'none'}.md`, dir), `${sheet}\n`);
    return passed(out.runs) ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
