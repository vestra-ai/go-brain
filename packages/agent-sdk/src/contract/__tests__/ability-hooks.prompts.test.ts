// X6 (harness to nine): prompt and agent hooks are parsed beside the commands, so a group may
// carry words as well as scripts. A config with commands only parses exactly as before (no
// `prompts` key), which keeps every existing skill's served bytes and checksum unchanged.
import { describe, it, expect } from 'vitest';
import { parseAbilityHooks } from '../ability-hooks.js';

describe('parseAbilityHooks: prompt and agent hooks', () => {
  it('keeps prompt and agent entries beside the commands, in order', () => {
    expect(parseAbilityHooks({
      Stop: [{
        hooks: [
          { type: 'command', command: 'sh x.sh' },
          { type: 'prompt', prompt: 'Summarise what changed.' },
          { type: 'agent', prompt: 'Check the tests pass.' },
        ],
      }],
    })).toEqual({
      Stop: [{
        hooks: [{ type: 'command', command: 'sh x.sh' }],
        prompts: [{ type: 'prompt', prompt: 'Summarise what changed.' }, { type: 'agent', prompt: 'Check the tests pass.' }],
      }],
    });
  });

  it('a group of words alone is kept, with no commands', () => {
    expect(parseAbilityHooks({ UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Be brief.' }] }] }))
      .toEqual({ UserPromptSubmit: [{ hooks: [], prompts: [{ type: 'prompt', prompt: 'Be brief.' }] }] });
  });

  it('drops an entry with no words, and a group left with nothing', () => {
    expect(parseAbilityHooks({ Stop: [{ hooks: [{ type: 'prompt', prompt: '   ' }, { type: 'agent' }, { type: 'prompt', prompt: 7 }] }] }))
      .toBeUndefined();
  });

  it('a config with commands only parses exactly as before (no prompts key)', () => {
    const parsed = parseAbilityHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'g.sh', timeout: 5 }] }] });
    expect(parsed).toEqual({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'g.sh', timeout: 5 }] }] });
    expect('prompts' in parsed!.PreToolUse![0]!).toBe(false);
  });
});
