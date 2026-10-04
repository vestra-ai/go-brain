import { readFileSync } from 'node:fs';
const FORBIDDEN = ['password', 'apiKey', 'api_key', 'token', 'secret', 'serviceKey', 'service_key', 'credential'];
const src = readFileSync(new URL('../src/contract/journal.ts', import.meta.url), 'utf8');
const hits = FORBIDDEN.filter((f) => new RegExp(`\\b${f}\\b\\s*[?:]`, 'i').test(src));
if (hits.length) { console.error('Journal entry schema must be secret-free; found:', hits); process.exit(1); }
console.log('journal schema secret-free ✓');
