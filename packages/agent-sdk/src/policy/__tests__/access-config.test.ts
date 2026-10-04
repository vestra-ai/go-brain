import { describe, it, expect } from 'vitest';
import {
  compileAccessConfig,
  clampConfig,
  parseAccessConfig,
  type AccessConfig,
  type AppAction,
  type CompiledAccessConfig,
  type ConfigurableFamily,
} from '../access-config.js';
import { levelAsks, hardFloors, type AccessLevel } from '../access-level.js';
import type { SideEffectFamily } from '../side-effect-classifier.js';

const FAMILIES: SideEffectFamily[] = [
  'readonly', 'workspace_write', 'external_send',
  'external_mutation', 'dangerous_delete', 'payment',
];
const CONFIGURABLE: ConfigurableFamily[] = [
  'readonly', 'workspace_write', 'external_send',
  'external_mutation', 'dangerous_delete',
];
const PRESETS: AccessLevel[] = ['careful', 'balanced', 'relaxed', 'autopilot'];

describe('compileAccessConfig — preset equivalence (generated)', () => {
  for (const level of PRESETS) {
    it(`compile({level:'${level}'}) matches the levelAsks/hardFloors matrix`, () => {
      const c = compileAccessConfig({ level });
      for (const f of FAMILIES) {
        if (f === 'payment') { expect(c.silentFamilies.has(f)).toBe(false); continue; }
        const asks = levelAsks(f, level) || hardFloors(f, level);
        expect(c.silentFamilies.has(f)).toBe(!asks);
      }
    });
  }
});

describe('compileAccessConfig — custom', () => {
  it('custom base is the Relaxed column', () => {
    const c = compileAccessConfig({ level: 'custom' });
    expect([...c.silentFamilies].sort()).toEqual(['external_mutation', 'external_send', 'readonly', 'workspace_write']);
  });
  it('families toggles override the base in both directions', () => {
    const c = compileAccessConfig({ level: 'custom', families: { external_send: 'ask', dangerous_delete: 'allow' } });
    expect(c.silentFamilies.has('external_send')).toBe(false);
    expect(c.silentFamilies.has('dangerous_delete')).toBe(true);
  });
  it('payment is never silent and payment app-keys are dropped', () => {
    const c = compileAccessConfig({ level: 'custom', apps: { stripe: { payment: 'allow', external_mutation: 'block' } } } as AccessConfig);
    expect(c.silentFamilies.has('payment')).toBe(false);
    expect(c.apps.get('stripe')?.payment).toBeUndefined();
    expect(c.apps.get('stripe')?.external_mutation).toBe('block');
  });
  it('toolkit keys lowercase; unknown families/values dropped; total on garbage', () => {
    const c = compileAccessConfig({ level: 'custom', apps: { GMAIL: { external_send: 'block', bogus: 'block', external_mutation: 'sideways' } } } as unknown as AccessConfig);
    expect(c.apps.get('gmail')?.external_send).toBe('block');
    expect(Object.keys(c.apps.get('gmail') ?? {})).toEqual(['external_send']);
    expect(() => compileAccessConfig({} as AccessConfig)).not.toThrow();
  });
  it('missing/garbage level compiles to the custom (Relaxed-column) base', () => {
    for (const cfg of [{}, { level: 'sideways' }] as unknown as AccessConfig[]) {
      const c = compileAccessConfig(cfg);
      expect([...c.silentFamilies].sort()).toEqual(['external_mutation', 'external_send', 'readonly', 'workspace_write']);
    }
  });
  it('app entries left empty after normalization are dropped', () => {
    const c = compileAccessConfig({ level: 'custom', apps: { stripe: { payment: 'allow' } } } as AccessConfig);
    expect(c.apps.has('stripe')).toBe(false);
  });
});

// ── clamp property space: every subset of the 5 configurable families, as an
// explicit custom config, PLUS the four presets — exhaustive on both sides. ──

/** All 2^5 subsets of the configurable families, as bitmask-indexed sets. */
function allFamilySubsets(): Set<Exclude<SideEffectFamily, 'payment'>>[] {
  const subsets: Set<Exclude<SideEffectFamily, 'payment'>>[] = [];
  for (let mask = 0; mask < 1 << CONFIGURABLE.length; mask++) {
    const s = new Set<ConfigurableFamily>();
    CONFIGURABLE.forEach((f, i) => { if (mask & (1 << i)) s.add(f); });
    subsets.push(s);
  }
  return subsets;
}

/** A fully explicit custom config whose silent set is exactly `silent`. */
function customConfigFor(silent: ReadonlySet<string>): AccessConfig {
  const families: AccessConfig['families'] = {};
  for (const f of CONFIGURABLE) families[f] = silent.has(f) ? 'allow' : 'ask';
  return { level: 'custom', families };
}

describe('clampConfig — tighten-only (exhaustive property, 36×36 config space)', () => {
  // Config space per side: all 32 explicit-custom silent subsets + the 4 presets.
  const space: AccessConfig[] = [
    ...allFamilySubsets().map(customConfigFor),
    ...PRESETS.map((level): AccessConfig => ({ level })),
  ];

  it('compile(clamped).silentFamilies = child ∩ parent silence, for every pair', () => {
    for (const child of space) {
      for (const parent of space) {
        const cc = compileAccessConfig(child);
        const cp = compileAccessConfig(parent);
        const clamped = compileAccessConfig(clampConfig(child, parent));
        for (const f of FAMILIES) {
          expect(clamped.silentFamilies.has(f))
            .toBe(cc.silentFamilies.has(f) && cp.silentFamilies.has(f));
        }
      }
    }
  });

  it('is identity-preserving: a child already within the parent comes back by reference', () => {
    for (const child of space) {
      for (const parent of space) {
        const cc = compileAccessConfig(child);
        const cp = compileAccessConfig(parent);
        const within = [...cc.silentFamilies].every((f) => cp.silentFamilies.has(f));
        if (within) expect(clampConfig(child, parent)).toBe(child);
        else expect(clampConfig(child, parent)).not.toBe(child);
      }
    }
  });
});

describe('clampConfig — app entries', () => {
  it('every parent app block survives, beating any child value', () => {
    const childValues: (AppAction | undefined)[] = [undefined, 'ask', 'allow', 'block'];
    for (const v of childValues) {
      const child: AccessConfig = v
        ? { level: 'custom', apps: { gmail: { external_send: v } } }
        : { level: 'custom' };
      const parent: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'block' } } };
      const clamped = compileAccessConfig(clampConfig(child, parent));
      expect(clamped.apps.get('gmail')?.external_send).toBe('block');
    }
  });
  it('child-added blocks and asks survive the clamp', () => {
    const child: AccessConfig = {
      level: 'custom',
      families: { external_send: 'allow' },
      apps: { gmail: { external_send: 'block' }, notion: { external_mutation: 'ask' } },
    };
    const parent: AccessConfig = { level: 'custom', families: { external_send: 'ask' } };
    const clamped = compileAccessConfig(clampConfig(child, parent));
    expect(clamped.apps.get('gmail')?.external_send).toBe('block');
    expect(clamped.apps.get('notion')?.external_mutation).toBe('ask');
  });
  it('parent app allows do NOT propagate; ask-pins DO (union, like blocks)', () => {
    const child: AccessConfig = { level: 'custom' };
    const parent: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'ask', external_mutation: 'allow' } } };
    const out = clampConfig(child, parent);
    expect(out).not.toBe(child); // the unioned pin is a change
    const clamped = compileAccessConfig(out);
    expect(clamped.apps.get('gmail')?.external_send).toBe('ask');
    expect(clamped.apps.get('gmail')?.external_mutation).toBeUndefined();
  });
  it('a parent ask-pin unions in against every child value except block', () => {
    const cases: { childValue: AppAction | undefined; expected: AppAction }[] = [
      { childValue: undefined, expected: 'ask' },
      { childValue: 'ask', expected: 'ask' },
      { childValue: 'allow', expected: 'ask' }, // allow strips (parent gates the cell), pin unions in
      { childValue: 'block', expected: 'block' }, // a child block outranks a parent ask-pin
    ];
    for (const { childValue, expected } of cases) {
      const child: AccessConfig = childValue
        ? { level: 'custom', apps: { gmail: { external_send: childValue } } }
        : { level: 'custom' };
      const parent: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'ask' } } };
      const clamped = compileAccessConfig(clampConfig(child, parent));
      expect(clamped.apps.get('gmail')?.external_send).toBe(expected);
    }
  });
  it('a child already carrying the parent ask-pin comes back by reference', () => {
    const child: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'ask' } } };
    const parent: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'ask' } } };
    expect(clampConfig(child, parent)).toBe(child);
  });
});

describe('clampConfig — per-app allow strip rule (call-level tighten)', () => {
  // A fully explicit custom base whose only loosenings are the app entries under test.
  const strictFamilies: AccessConfig['families'] = {
    readonly: 'allow', workspace_write: 'allow',
    external_send: 'ask', external_mutation: 'ask', dangerous_delete: 'ask',
  };

  it('a child app-allow is STRIPPED when the parent asks for that family globally', () => {
    const child: AccessConfig = { level: 'custom', families: strictFamilies, apps: { gmail: { external_send: 'allow' } } };
    const parent: AccessConfig = { level: 'balanced' }; // asks external_send globally
    const out = clampConfig(child, parent);
    expect(out).not.toBe(child);
    expect(compileAccessConfig(out).apps.get('gmail')).toBeUndefined();
  });
  it('a child app-allow SURVIVES under parent global silence on that family', () => {
    const child: AccessConfig = { level: 'custom', families: strictFamilies, apps: { gmail: { external_send: 'allow' } } };
    const parent: AccessConfig = { level: 'relaxed' }; // external_send silent globally
    expect(clampConfig(child, parent)).toBe(child);
  });
  it("a child app-allow SURVIVES under the parent's own app-allow on the same cell", () => {
    const child: AccessConfig = { level: 'custom', families: strictFamilies, apps: { gmail: { external_send: 'allow' } } };
    const parent: AccessConfig = { level: 'balanced', apps: { gmail: { external_send: 'allow' } } };
    expect(clampConfig(child, parent)).toBe(child);
  });
  it("a parent app ask-pin beats parent global silence — the child's allow strips and the pin unions in", () => {
    // Precedence within a config: app ask > global family toggle. The parent HARD-asks
    // gmail sends despite its global silence, so the parent does NOT silence this cell.
    const child: AccessConfig = { level: 'custom', families: strictFamilies, apps: { gmail: { external_send: 'allow' } } };
    const parent: AccessConfig = { level: 'relaxed', apps: { gmail: { external_send: 'ask' } } };
    const out = clampConfig(child, parent);
    expect(out).not.toBe(child);
    expect(compileAccessConfig(out).apps.get('gmail')?.external_send).toBe('ask');
  });
  it('a per-app dangerous_delete lift is gated on the parent delete posture for that cell', () => {
    const child: AccessConfig = { level: 'custom', families: strictFamilies, apps: { stripe: { dangerous_delete: 'allow' } } };
    // relaxed parent: delete floor NOT lifted → stripped
    const clampedStrict = clampConfig(child, { level: 'relaxed' });
    expect(compileAccessConfig(clampedStrict).apps.get('stripe')).toBeUndefined();
    // autopilot parent: delete silent globally → survives (child unchanged)
    expect(clampConfig(child, { level: 'autopilot' })).toBe(child);
    // relaxed parent with its OWN per-app lift on the same cell → survives
    expect(clampConfig(child, { level: 'relaxed', apps: { stripe: { dangerous_delete: 'allow' } } })).toBe(child);
  });
  it('child app asks/blocks are never stripped (tightenings always survive)', () => {
    const child: AccessConfig = {
      level: 'custom', families: strictFamilies,
      apps: { gmail: { external_send: 'ask' }, notion: { external_mutation: 'block' } },
    };
    const out = clampConfig(child, { level: 'balanced' });
    const c = compileAccessConfig(out);
    expect(c.apps.get('gmail')?.external_send).toBe('ask');
    expect(c.apps.get('notion')?.external_mutation).toBe('block');
  });
});

// ── call-level property: no (toolkit, family) cell silent under the clamped child
// may be non-silent under the parent. EFFECTIVE cell posture on BOTH sides (round-2
// amendment): an app pin beats the global toggle — only an allow-pin silences a cell,
// an ask/block pin gates it even under global silence. payment is never configurable —
// compile guarantees it is neither globally silent nor present in app entries. ──

function silentFor(compiled: CompiledAccessConfig, toolkit: string, family: SideEffectFamily): boolean {
  const appAction = compiled.apps.get(toolkit)?.[family];
  if (appAction !== undefined) return appAction === 'allow';
  return compiled.silentFamilies.has(family);
}

describe('clampConfig — call-level tighten-only (decorated exhaustive property)', () => {
  const TOOLKITS = ['gmail', 'stripe', 'github', 'slack']; // slack = never configured
  const APP_OVERLAYS: (AccessConfig['apps'] | undefined)[] = [
    undefined,
    { gmail: { external_send: 'allow' } },
    { gmail: { external_send: 'ask' } },
    { gmail: { external_send: 'block' } },
    { stripe: { dangerous_delete: 'allow' } },
    { github: { external_mutation: 'allow', workspace_write: 'ask' } },
  ];

  it('every cell silent under compile(clamp(child,parent)) is silent under compile(parent)', () => {
    // 36 silent-space bases × 6 app overlays = 216 configs per side, all pairs.
    const bases: AccessConfig[] = [
      ...allFamilySubsets().map(customConfigFor),
      ...PRESETS.map((level): AccessConfig => ({ level })),
    ];
    const space: AccessConfig[] = bases.flatMap((base) =>
      APP_OVERLAYS.map((apps) => (apps ? { ...base, apps } : base)),
    );
    const compiled = space.map((cfg) => compileAccessConfig(cfg));

    const violations: string[] = [];
    for (let i = 0; i < space.length; i++) {
      for (let j = 0; j < space.length; j++) {
        const clamped = compileAccessConfig(clampConfig(space[i], space[j]));
        for (const toolkit of TOOLKITS) {
          for (const family of FAMILIES) {
            if (silentFor(clamped, toolkit, family) && !silentFor(compiled[j], toolkit, family)) {
              violations.push(`child#${i} parent#${j} ${toolkit}.${family}`);
            }
          }
        }
        if (violations.length > 20) break;
      }
      if (violations.length > 20) break;
    }
    expect(violations).toEqual([]);
  });
});

describe('clampConfig — frozen semantics spot checks', () => {
  it('dangerous_delete lift requires the parent to have lifted it too', () => {
    const child: AccessConfig = { level: 'custom', families: { dangerous_delete: 'allow' } };
    expect(compileAccessConfig(clampConfig(child, { level: 'relaxed' })).silentFamilies.has('dangerous_delete')).toBe(false);
    expect(compileAccessConfig(clampConfig(child, { level: 'autopilot' })).silentFamilies.has('dangerous_delete')).toBe(true);
  });
  it('a stricter preset child under a looser preset parent is returned unchanged', () => {
    const child: AccessConfig = { level: 'careful' };
    expect(clampConfig(child, { level: 'balanced' })).toBe(child);
  });
  it('a looser preset child materializes as an explicit custom config clamped to the parent', () => {
    const out = clampConfig({ level: 'autopilot' }, { level: 'balanced' });
    expect(out.level).toBe('custom');
    const c = compileAccessConfig(out);
    expect([...c.silentFamilies].sort()).toEqual(['readonly', 'workspace_write']);
  });
});

describe('parseAccessConfig', () => {
  it('round-trips a valid config and nulls garbage', () => {
    const cfg: AccessConfig = { level: 'custom', families: { workspace_write: 'ask' }, apps: { gmail: { external_send: 'block' } } };
    expect(parseAccessConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
    expect(parseAccessConfig('nonsense')).toBeNull();
    expect(parseAccessConfig({ level: 'sideways' })).toBeNull();
  });
  it('round-trips every preset level', () => {
    for (const level of PRESETS) expect(parseAccessConfig({ level })).toEqual({ level });
  });
  it('nulls non-object shapes and invalid field structures', () => {
    expect(parseAccessConfig(null)).toBeNull();
    expect(parseAccessConfig(undefined)).toBeNull();
    expect(parseAccessConfig([])).toBeNull();
    expect(parseAccessConfig(42)).toBeNull();
    expect(parseAccessConfig({})).toBeNull();
    expect(parseAccessConfig({ level: 'custom', families: 'loose' })).toBeNull();
    expect(parseAccessConfig({ level: 'custom', apps: [] })).toBeNull();
  });
  it('drops unknown inner keys/values instead of nulling (forward compat)', () => {
    expect(parseAccessConfig({ level: 'custom', families: { bogus: 'ask', external_send: 'sideways', workspace_write: 'allow' } }))
      .toEqual({ level: 'custom', families: { workspace_write: 'allow' } });
    expect(parseAccessConfig({ level: 'custom', apps: { gmail: { external_send: 'block', bogus: 'block' }, broken: 'nope' } }))
      .toEqual({ level: 'custom', apps: { gmail: { external_send: 'block' } } });
  });
  it('never admits payment into families', () => {
    expect(parseAccessConfig({ level: 'custom', families: { payment: 'allow' } }))
      .toEqual({ level: 'custom', families: {} });
  });
  it('drops payment keys inside apps.* too (defense-in-depth, matching compile)', () => {
    expect(parseAccessConfig({ level: 'custom', apps: { stripe: { payment: 'allow', external_mutation: 'block' } } }))
      .toEqual({ level: 'custom', apps: { stripe: { external_mutation: 'block' } } });
    // an app entry that only held payment vanishes entirely
    expect(parseAccessConfig({ level: 'custom', apps: { stripe: { payment: 'allow' } } }))
      .toEqual({ level: 'custom', apps: {} });
  });
});
