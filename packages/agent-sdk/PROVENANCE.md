# Provenance

Copied on 2026-10-04 from `vestra-ai/bash` at `e3010f4df5cdec2ff1d402a3a7e01af9a9975f23`,
path `packages/agent-sdk` (the native, provider-agnostic agent loop, already extracted to run standalone).

This is a one-way copy. go-brain owns it from here; nothing flows back into the Bash monorepo, and
changes there do not reach this copy unless someone copies them on purpose. Only change in the copy:
`tsconfig.json` extends `../../tsconfig.base.json` (a copy of bash's `packages/shared/tsconfig.json`).

Also changed in the copy:
- Removed `bench/__tests__/compare.test.ts` and `src/kernel/journal/__tests__/mirror-clamp.migration.test.ts`: they
  check files that only exist in the Bash monorepo (its nightly bench workflow and a Supabase migration).
- The root `package.json` pins `zod 4.3.6`, `openai 6.39.1` and `yaml 2.9.0`, the versions Bash runs, so the
  copied wire-schema tests stay byte-identical.
