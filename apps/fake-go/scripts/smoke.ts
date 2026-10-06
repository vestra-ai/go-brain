// pnpm --filter @go/fake-go smoke: checks a deployed fake Go end to end. Needs GO_URL and GO_SIGNING_SECRET.
import { runSmoke } from '../src/smoke.js';

const goUrl = process.env.GO_URL;
const secret = process.env.GO_SIGNING_SECRET;
if (!goUrl || !secret) {
  console.error('Set GO_URL (the https base, no path) and GO_SIGNING_SECRET first.');
  process.exit(2);
}
const report = await runSmoke({ goUrl, secret });
console.log(report.ok ? `SMOKE OK: ${report.goRequests.join(', ')}` : `SMOKE FAILED:\n- ${report.problems.join('\n- ')}`);
process.exit(report.ok ? 0 : 1);
