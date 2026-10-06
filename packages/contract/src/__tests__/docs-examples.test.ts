import { describe, expect, it } from 'vitest';
import { checkDocsExamples } from '../../scripts/docs-examples.js';

describe('the guide', () => {
  const { checked, problems, missing } = checkDocsExamples();
  it('has checked examples', () => {
    expect(checked).toBeGreaterThan(0);
  });
  it('every JSON example matches its schema', () => {
    expect(problems.map((p) => `${p.file} ${p.schema}: ${p.message}`)).toEqual([]);
  });
  it('every event, card, request and response has a checked example', () => {
    expect(missing).toEqual([]);
  });
});
