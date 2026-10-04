import { describe, it, expect, afterEach } from 'vitest';
import {
  bashAstGateEnabled,
  webFetchGuardEnabled,
  webFetchStoreEnabled,
  accessLevelsEnabled,
  severedStreamRetryEnabled,
  mediaFileIdAnthropicEnabled,
  mediaFileIdOpenAIEnabled,
  mediaInlineChatEnabled,
  mediaInlineGeminiEnabled,
  editHardenEnabled,
  contextElisionEnabled,
  toolOutputTokenBudgetEnabled,
  videoUnderstandingEnabled,
  retryByCauseEnabled,
  hookParityEnabled,
  toolDeferWideEnabled,
  toolSchemaCompactEnabled,
  toolDescLeanEnabled,
  toolConcurrencyClassesEnabled,
  toolsMidstreamEnabled,
  laneFallbackEnabled,
  networkWaitEnabled,
  toolsMidstreamRwEnabled,
  shellSessionEnabled,
  toolResultShapeEnabled,
  securityPatternsV2Enabled,
  mcpInvokeResolvedGateEnabled,
  silentDeathsEnabled,
  postTurnOffPathEnabled,
  compactionPostTurnEnabled,
  subagentUsageLedgerEnabled,
  contextAppendEnabled,
  billCacheWrite1hEnabled,
  sweepEffortMessageEnabled,
  sweepParityByPrefixEnabled,
  screenshotPruneCacheEnabled,
  chatTailAfterToolsEnabled,
  responsesMemoryInputEnabled,
} from '../feature-flags.js';

// The exact string set the reviewers asked for: covers a truthy-looking non-'true'
// ('1'), the on token ('true'), both off tokens ('false' and '0'), unset, and empty.
// IDENTICAL to the matrix in @bash/shared flags/__tests__/registry.test.ts — the two
// pin agent-sdk's local kill-switch-strict accessor and the shared registry's
// kill-switch-strict semantics to the same truth table (the engine cannot import
// @bash/shared, so this is the mirror+conformance proof, per capture-signal.ts).
const MATRIX = ['1', 'true', 'false', '0', undefined, ''] as const;

// Independent oracle — kill-switch-strict: ON unless the value is exactly '0' or 'false'.
const killSwitchStrict = (v: string | undefined) => v !== '0' && v !== 'false';

const FLAGS: Array<[string, () => boolean]> = [
  ['VESTRA_BASH_AST_GATE', bashAstGateEnabled],
  ['VESTRA_WEBFETCH_GUARD', webFetchGuardEnabled],
  ['VESTRA_WEBFETCH_STORE', webFetchStoreEnabled],
];

afterEach(() => {
  for (const [name] of FLAGS) delete process.env[name];
});

describe('P0 safety-floor flags — behavior identity (kill-switch-strict, default ON)', () => {
  for (const [name, fn] of FLAGS) {
    for (const v of MATRIX) {
      const expected = killSwitchStrict(v);
      it(`${name}=${JSON.stringify(v)} → ${expected}`, () => {
        if (v === undefined) delete process.env[name];
        else process.env[name] = v;
        expect(fn()).toBe(expected);
      });
    }
  }

  it('kill-switch-strict differs from plain kill-switch on the string "0" (OFF here)', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(bashAstGateEnabled()).toBe(false);
  });
});

// ACCESS_LEVELS_V1 is the FIRST opt-in flag (default OFF) — a new feature ships
// dark, so OFF must be byte-identical to today. Distinct semantics from the
// kill-switches above: ON only on the explicit '1'/'true' tokens.
describe('ACCESS_LEVELS_V1 — opt-in (default OFF, ON only on "1" or "true")', () => {
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

  const optIn = (v: string | undefined) => v === '1' || v === 'true';
  for (const v of ['1', 'true', 'false', '0', undefined, '', 'yes'] as const) {
    const expected = optIn(v);
    it(`ACCESS_LEVELS_V1=${JSON.stringify(v)} → ${expected}`, () => {
      if (v === undefined) delete process.env.ACCESS_LEVELS_V1;
      else process.env.ACCESS_LEVELS_V1 = v;
      expect(accessLevelsEnabled()).toBe(expected);
    });
  }

  it('is OFF when unset (dark by default)', () => {
    delete process.env.ACCESS_LEVELS_V1;
    expect(accessLevelsEnabled()).toBe(false);
  });
});

// Deploy-seam ladder 1 — same opt-in semantics as ACCESS_LEVELS_V1: ships dark,
// OFF must be byte-identical to today (severance stays a terminal model_error).
describe('NATIVE_STREAM_SEVERED_RETRY — opt-in (default OFF, ON only on "1" or "true")', () => {
  afterEach(() => { delete process.env.NATIVE_STREAM_SEVERED_RETRY; });

  const optIn = (v: string | undefined) => v === '1' || v === 'true';
  for (const v of ['1', 'true', 'false', '0', undefined, '', 'yes'] as const) {
    const expected = optIn(v);
    it(`NATIVE_STREAM_SEVERED_RETRY=${JSON.stringify(v)} → ${expected}`, () => {
      if (v === undefined) delete process.env.NATIVE_STREAM_SEVERED_RETRY;
      else process.env.NATIVE_STREAM_SEVERED_RETRY = v;
      expect(severedStreamRetryEnabled()).toBe(expected);
    });
  }

  it('is OFF when unset (dark by default)', () => {
    delete process.env.NATIVE_STREAM_SEVERED_RETRY;
    expect(severedStreamRetryEnabled()).toBe(false);
  });
});

// Media-refs S1 lane flags — four independent opt-in gates, one per model lane
// (spec §Rule 3). Same semantics table as ACCESS_LEVELS_V1: ships dark, OFF is
// byte-identical to today's wire body for that lane.
describe('media-refs S1 lane flags — opt-in (default OFF, ON only on "1" or "true")', () => {
  const LANE_FLAGS: Array<[string, () => boolean]> = [
    ['MEDIA_FILE_ID_ANTHROPIC_V1', mediaFileIdAnthropicEnabled],
    ['MEDIA_FILE_ID_OPENAI_V1', mediaFileIdOpenAIEnabled],
    ['MEDIA_INLINE_CHAT_V1', mediaInlineChatEnabled],
    ['MEDIA_INLINE_GEMINI_V1', mediaInlineGeminiEnabled],
    // Same opt-in semantics, same dark-by-default contract — Edit's argument
    // repair + deterministic fuzzy match.
    ['EDIT_HARDEN_V1', editHardenEnabled],
    ['CONTEXT_ELISION_V1', contextElisionEnabled],
    ['TOOL_OUTPUT_TOKEN_BUDGET_V1', toolOutputTokenBudgetEnabled],
    ['RETRY_BY_CAUSE_V1', retryByCauseEnabled],
    ['HOOK_PARITY_V1', hookParityEnabled],
    ['TOOL_DEFER_WIDE_V1', toolDeferWideEnabled],
    ['TOOL_SCHEMA_COMPACT_V1', toolSchemaCompactEnabled],
    ['TOOL_DESC_LEAN_V1', toolDescLeanEnabled],
    ['TOOL_CONCURRENCY_CLASSES_V1', toolConcurrencyClassesEnabled],
    ['TOOLS_MIDSTREAM_V1', toolsMidstreamEnabled],
    ['LANE_FALLBACK_V1', laneFallbackEnabled],
    ['NETWORK_WAIT_V1', networkWaitEnabled],
    ['TOOLS_MIDSTREAM_RW_V1', toolsMidstreamRwEnabled],
    ['SHELL_SESSION_V1', shellSessionEnabled],
    ['TOOL_RESULT_SHAPE_V1', toolResultShapeEnabled],
    ['SECURITY_PATTERNS_V2', securityPatternsV2Enabled],
    ['MCP_INVOKE_RESOLVED_GATE_V1', mcpInvokeResolvedGateEnabled],
    ['SILENT_DEATHS_V1', silentDeathsEnabled],
    ['POST_TURN_OFF_PATH_V1', postTurnOffPathEnabled],
    ['COMPACTION_POST_TURN_V1', compactionPostTurnEnabled],
    ['SUBAGENT_USAGE_LEDGER_V1', subagentUsageLedgerEnabled],
    ['CONTEXT_APPEND_V1', contextAppendEnabled],
    ['BILL_CACHE_WRITE_1H_V1', billCacheWrite1hEnabled],
    ['SWEEP_EFFORT_MESSAGE_V1', sweepEffortMessageEnabled],
    ['SWEEP_PARITY_BY_PREFIX_V1', sweepParityByPrefixEnabled],
    ['SCREENSHOT_PRUNE_CACHE_V1', screenshotPruneCacheEnabled],
    ['CHAT_TAIL_AFTER_TOOLS_V1', chatTailAfterToolsEnabled],
    ['RESPONSES_MEMORY_INPUT_V1', responsesMemoryInputEnabled],
  ];

  afterEach(() => {
    for (const [name] of LANE_FLAGS) delete process.env[name];
  });

  const optIn = (v: string | undefined) => v === '1' || v === 'true';
  for (const [name, fn] of LANE_FLAGS) {
    for (const v of ['1', 'true', 'false', '0', undefined, '', 'yes'] as const) {
      const expected = optIn(v);
      it(`${name}=${JSON.stringify(v)} → ${expected}`, () => {
        if (v === undefined) delete process.env[name];
        else process.env[name] = v;
        expect(fn()).toBe(expected);
      });
    }
  }
});

// VIDEO_UNDERSTANDING_V1 — uploaded video/audio/PDF reach the model (spec
// 2026-09-04). Ships dark: OFF mints no `media` block and registers no `watch`
// tool, so every wire stays byte-identical.
describe('VIDEO_UNDERSTANDING_V1 — opt-in (default OFF, ON only on "1" or "true")', () => {
  afterEach(() => {
    delete process.env.VIDEO_UNDERSTANDING_V1;
  });

  it('VIDEO_UNDERSTANDING_V1 is opt-in: unset/false → off, "true"/"1" → on', () => {
    delete process.env.VIDEO_UNDERSTANDING_V1;
    expect(videoUnderstandingEnabled()).toBe(false);
    process.env.VIDEO_UNDERSTANDING_V1 = 'false'; expect(videoUnderstandingEnabled()).toBe(false);
    process.env.VIDEO_UNDERSTANDING_V1 = 'true';  expect(videoUnderstandingEnabled()).toBe(true);
    process.env.VIDEO_UNDERSTANDING_V1 = '1';     expect(videoUnderstandingEnabled()).toBe(true);
    delete process.env.VIDEO_UNDERSTANDING_V1;
  });
});
