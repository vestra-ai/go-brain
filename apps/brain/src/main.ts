import { pathToFileURL } from 'node:url';
import { buildBrain, type RegisterLane } from './app.js';
import { loadEnv } from './env.js';
import { registerMemory } from './memory/register.js';
import { registerProactive } from './proactive/register.js';
import { registerReflex } from './reflex/register.js';
import { registerRoom } from './room.js';
import { registerTasks } from './tasks/register.js';
import { registerTravel } from './travel/register.js';

/**
 * The lanes, in boot order: registerRoom, registerReflex, registerMemory, registerStats, registerTravel,
 * registerTasks, registerMoney, registerProactive, registerCalls, registerAdmin. Each lane adds its one
 * line here, in that order, in its own PR.
 */
export const LANES: RegisterLane[] = [registerRoom, registerReflex, registerMemory, registerTravel, registerTasks, registerProactive];

export async function main(): Promise<void> {
  const env = loadEnv();
  const built = await buildBrain(env);
  for (const lane of LANES) await lane(built.brain);
  const { port } = await built.start();
  built.brain.log.info({ port, model: env.COMPOSER_MODEL }, 'Go is listening');
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void built.stop().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
