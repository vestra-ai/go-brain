// GO_URL=https://<go> GO_SIGNING_SECRET=... pnpm --filter @go/sim live-smoke
// Connects a FakeServer to a deployed Go as instance "smoke", makes a fresh smoke trip, says two lines and prints how
// fast Go answered. Exits 1 when typing took over 1 s or a reply did not come within 15 s, 2 when it could not start.
// The URL and the secret come from the environment only, never argv, so the secret stays out of shell history and ps.
import { FakeServer } from '../src/fake-server.js';
import { formatReport, runSmoke } from '../src/live-smoke.js';

const goUrl = process.env['GO_URL'];
const secret = process.env['GO_SIGNING_SECRET'];
if (!goUrl || !secret) {
  console.error('Set GO_URL and GO_SIGNING_SECRET in the environment.');
  process.exit(2);
}

const fake = new FakeServer({ goUrl, secret, instance: 'smoke' });
console.log(`Connecting to Go at ${new URL(goUrl).origin} as instance "smoke"`);
try {
  await fake.start(10_000);
} catch {
  console.error('Could not open the socket to Go within 10 s. Check GO_URL, GO_SIGNING_SECRET and /health.');
  fake.stop();
  process.exit(2);
}
try {
  const report = await runSmoke({ server: fake });
  console.log(formatReport(report));
  process.exitCode = report.verdict.ok ? 0 : 1;
} catch (err) {
  console.error(`The smoke stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  fake.stop();
}
