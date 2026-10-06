// tsc does not copy .sql files; the service reads its migrations from dist/db/migrations.
import { cpSync, rmSync } from 'node:fs';

const from = new URL('../src/db/migrations/', import.meta.url);
const to = new URL('../dist/db/migrations/', import.meta.url);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
