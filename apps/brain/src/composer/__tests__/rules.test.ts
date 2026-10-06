import { describe, expect, it } from 'vitest';
import { GO_RULES } from '../rules.js';

describe("Go's rules", () => {
  it('send "forget me" to the App: Go cannot forget from the chat and never says it did', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nForget me\n'), GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain("You cannot forget anyone from the chat. If someone asks you in the chat to forget them or what you know about them, say you can't do that from here");
    expect(section).toContain('"Forget me in this trip" on their You screen in the App');
    expect(section).toContain('Never say you forgot or deleted anything about a person yourself.');
  });

  it('use no em dashes or en dashes, as they ask of Go', () => {
    expect(GO_RULES).not.toMatch(/[—–]/);
  });
});
