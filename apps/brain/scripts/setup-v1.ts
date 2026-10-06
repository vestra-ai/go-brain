/**
 * One-time /v1 setup for Go. Run by hand with an all-scoped key (admin and setup), of the mode Go will run in:
 *   VESTRA_API_URL=https://api-staging.vestra.ai VESTRA_SETUP_KEY=vk_test_... GO_PUBLIC_URL=https://<go's public host> \
 *     pnpm --filter ./apps/brain setup-v1 [--deny-tools] [--model <model id>]
 * Run it again with --deny-tools once Bash PR 2 (deny_tools on deployments) is on the target: it saves a new version.
 */
import { setupV1 } from '../src/tasks/setup-v1.js';

const args = process.argv.slice(2);
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is not set\n`);
    process.exit(1);
  }
  return value;
};
const modelAt = args.indexOf('--model');
const model = modelAt >= 0 ? args[modelAt + 1] : undefined;

await setupV1({
  baseUrl: need('VESTRA_API_URL'),
  key: need('VESTRA_SETUP_KEY'),
  publicUrl: need('GO_PUBLIC_URL'),
  denyTools: args.includes('--deny-tools'),
  ...(model ? { model } : {}),
});
