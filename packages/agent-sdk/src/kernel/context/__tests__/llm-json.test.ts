import { describe, it, expect } from 'vitest';
import { extractJsonValue } from '../llm-json.js';

describe('extractJsonValue', () => {
  it('parses a pure empty array', () => {
    expect(extractJsonValue('[]')).toEqual([]);
  });

  it('parses a pure array of strings', () => {
    expect(extractJsonValue('["a","b"]')).toEqual(['a', 'b']);
  });

  it('strips a ```json fence', () => {
    expect(extractJsonValue('```json\n["a","b"]\n```')).toEqual(['a', 'b']);
  });

  it('strips a bare ``` fence', () => {
    expect(extractJsonValue('```\n[]\n```')).toEqual([]);
  });

  it('tolerates trailing prose after the JSON (the live bug)', () => {
    // Haiku returns the array FOLLOWED by an explanation — this is exactly the
    // "Unexpected non-whitespace character after JSON at position 3" failure.
    expect(extractJsonValue('[]\n\nThere are no claims that the new claim supersedes.')).toEqual([]);
    expect(extractJsonValue('["id1","id2"]\nThese ids are superseded by the new value.')).toEqual([
      'id1',
      'id2',
    ]);
  });

  it('tolerates leading prose before the JSON', () => {
    expect(extractJsonValue('Here is the answer:\n["x"]')).toEqual(['x']);
  });

  it('tolerates leading AND trailing prose', () => {
    expect(extractJsonValue('Sure, here you go:\n["x","y"]\nThat is all.')).toEqual(['x', 'y']);
  });

  it('parses an object value', () => {
    expect(extractJsonValue('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
  });

  it('parses an object with trailing prose', () => {
    expect(extractJsonValue('{"preferences":"x"}\nDone.')).toEqual({ preferences: 'x' });
  });

  it('returns undefined for garbage with no JSON value', () => {
    expect(extractJsonValue('I could not find anything to report.')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractJsonValue('')).toBeUndefined();
  });

  it('handles nested brackets', () => {
    expect(extractJsonValue('[["a"],["b","c"]]')).toEqual([['a'], ['b', 'c']]);
    expect(extractJsonValue('{"nested":{"x":[1,2]}}')).toEqual({ nested: { x: [1, 2] } });
  });

  it('handles bracket characters inside strings without mis-matching', () => {
    // A string value containing ] / } must not prematurely close the value.
    expect(extractJsonValue('["a]b","c}d"]')).toEqual(['a]b', 'c}d']);
    expect(extractJsonValue('{"k":"a [bracket] in a string"}')).toEqual({
      k: 'a [bracket] in a string',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonValue('["she said \\"hi\\""]')).toEqual(['she said "hi"']);
  });

  it('extracts the FIRST balanced value when prose contains a later bracket', () => {
    expect(extractJsonValue('["first"]\nsee also [bracketed prose]')).toEqual(['first']);
  });

  it('returns undefined when the first value is unbalanced/unparseable', () => {
    expect(extractJsonValue('["a","b"')).toBeUndefined();
  });

  it('chooses the earliest of [ or { as the start', () => {
    expect(extractJsonValue('prose [1,2] then {"a":1}')).toEqual([1, 2]);
    expect(extractJsonValue('prose {"a":1} then [1,2]')).toEqual({ a: 1 });
  });
});
