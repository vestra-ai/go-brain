/**
 * OVER-GATING REGRESSION — the in-workspace asset pipeline (founder ruling
 * 2026-09-03).
 *
 * On staging, at the default `relaxed` access level, this benign in-workspace
 * ffmpeg pipeline showed an "Allow Bash?" card and stalled a build. Everything
 * it does is inside the agent's OWN sandbox workspace: mkdir, a curl GET of the
 * agent's own generated asset (a plain download, no method flag), ffmpeg
 * transcodes writing into the workspace, printf/wc, and a `rm -f scratch/…` of a
 * scratch temp it created seconds earlier.
 *
 * TWO independent fires made it ask, both now fixed (see sensitivity-floor.ts):
 *   1. the `-f` FORCE flag was treated as dangerous (rule 1 of isDangerousDelete)
 *      — force never widens the target set, so a specific in-workspace file is
 *      safe; only RECURSION/glob/escape still gate.
 *   2. the leading `cd <workspace>` made the coarse `cwdMoved` boolean doom every
 *      relative delete — the cwd is now resolved order-aware, so a clean absolute
 *      in-workspace `cd` keeps relative deletes contained.
 *
 * Pinned BOTH directions: the benign pipeline (and each segment) auto-allows,
 * and genuinely consequential deletes STILL gate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sensitivityFloorAsks, classifyBashCommand, decideToolGate } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';

/** The founder's real session workspace root (the gate cwd in the sandbox). */
const ROOT = '/app/workspace/vestra-bash-0113ab98-9947-4f74-b007-11c607523314';

/** The EXACT pipeline from the founder's screenshot (URL shortened only). */
const ASSET_PIPELINE = [
  'set -e',
  'cd /app/workspace/vestra-bash-0113ab98-9947-4f74-b007-11c607523314',
  'mkdir -p app/public/assets/world scratch',
  "curl --noproxy '*' -L --fail 'https://d8j0ntlcm91z4.cloudfront.net/user_3H88BNZrF2z94swPTeaclMcsqkf/hf.mp4' -o scratch/scene-source.mp4",
  "ffmpeg -v error -y -i scratch/scene-source.mp4 -an -vf 'unsharp=5:5:0.8:5:5:0.0' -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart app/public/assets/world/scene-01.mp4",
  "ffmpeg -v error -y -i scratch/scene-source.mp4 -an -vf \"scale=-2:'min(720,ih)',unsharp=5:5:0.6:5:5:0.0\" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -g 4 -keyint_min 4 -sc_threshold 0 -movflags +faststart app/public/assets/world/scene-01-mobile.mp4",
  'ffmpeg -v error -y -ss 0 -i app/public/assets/world/scene-01.mp4 -frames:v 1 -q:v 2 app/public/assets/world/scene-01-poster.png',
  "printf 'desktop '; wc -c < app/public/assets/world/scene-01.mp4",
  'rm -f scratch/scene-source.mp4',
].join('\n');

const floors = (command: string, shellCwd: string | null = ROOT): boolean =>
  sensitivityFloorAsks(
    { toolName: 'Bash', toolInput: { command }, toolCallId: 't' },
    { workspaceRoot: ROOT, shellCwd },
  );

const family = (command: string, shellCwd: string | null = ROOT): string =>
  classifyBashCommand(command, ROOT, shellCwd);

// ── the floor + family (level-independent) ───────────────────────────────────

describe('the in-workspace asset pipeline no longer floors', () => {
  it('the WHOLE pipeline runs silently and classifies as a workspace write', () => {
    expect(floors(ASSET_PIPELINE)).toBe(false);
    expect(family(ASSET_PIPELINE)).toBe('workspace_write');
  });

  it('every individual segment runs silently', () => {
    expect(floors('mkdir -p app/public/assets/world scratch')).toBe(false);
    expect(
      floors("curl --noproxy '*' -L --fail 'https://cdn.example.com/hf.mp4' -o scratch/scene-source.mp4"),
    ).toBe(false); // a plain GET download — no method flag
    expect(floors('ffmpeg -v error -y -i scratch/scene-source.mp4 app/public/assets/world/scene-01.mp4')).toBe(false);
    expect(floors('rm -f scratch/scene-source.mp4')).toBe(false); // the force-flag fire
    expect(floors("printf 'desktop '; wc -c < app/public/assets/world/scene-01.mp4")).toBe(false);
  });

  it('the leading in-workspace `cd` keeps the relative `rm` contained (the cwd fire)', () => {
    expect(floors('cd ' + ROOT + '\nrm -f scratch/scene-source.mp4')).toBe(false);
    expect(floors('cd ' + ROOT + '\nrm scratch/scene-source.mp4')).toBe(false); // even without -f
  });
});

// ── the consequential deletes STILL gate (both directions) ───────────────────

describe('genuinely consequential deletes still gate after the ruling', () => {
  it('a FORCE flag never rescues an escaping / glob / recursive target', () => {
    expect(floors('rm -f /etc/passwd')).toBe(true); // outside the workspace
    expect(floors('rm -f /app/scene.mp4')).toBe(true); // ABOVE the workspace (project root)
    expect(floors('rm -f scratch/*.mp4')).toBe(true); // glob
    expect(floors('rm -rf scratch')).toBe(true); // recursion (in-workspace, still gates)
    expect(floors('rm -f ../../../etc/passwd')).toBe(true); // traversal escape
  });

  it('the cwd resolution is ORDER-aware — a later cd never excuses an earlier escaped delete', () => {
    // cd /etc happens first, so `rm hostname` runs OUTSIDE the workspace; the
    // trailing `cd <workspace>` must not retroactively make it look safe.
    expect(floors('cd /etc\nrm hostname\ncd ' + ROOT)).toBe(true);
    // a relative cd is unknowable → doubt → ask.
    expect(floors('cd sub\nrm scratch/x')).toBe(true);
    // an opaque cwd mover (eval) → doubt → ask.
    expect(floors('eval "cd /etc"\nrm hostname')).toBe(true);
  });
});

// ── end-to-end through decideToolGate at the default `relaxed` level ──────────

describe('decideToolGate @ relaxed (ACCESS_LEVELS_V1 on)', () => {
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

  const gate = (command: string) => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const ctx: ToolGateContext = {
      mode: 'bypassPermissions', // the sandbox's production default
      accessLevel: 'relaxed',
      cwd: ROOT,
      shellCwd: ROOT,
      permissionRules: { allow: [], ask: [], deny: [] },
    };
    return decideToolGate({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' }, ctx);
  };

  it('AUTO-ALLOWS the benign pipeline (no card)', () => {
    expect(gate(ASSET_PIPELINE).decision).toBe('allow');
    expect(gate('rm -f scratch/scene-source.mp4').decision).toBe('allow');
  });

  it('still DENIES a recursive delete of the project root / home (security gate)', () => {
    expect(gate('rm -rf /app').decision).toBe('deny');
    expect(gate('rm -rf ~').decision).toBe('deny');
  });

  it('still ASKS on a delete that leaves the workspace, or a glob', () => {
    expect(gate('rm -f /etc/passwd').decision).toBe('needs_human');
    expect(gate('rm -f scratch/*.mp4').decision).toBe('needs_human');
    expect(gate('rm -f ../../secret.txt').decision).toBe('needs_human');
  });
});
