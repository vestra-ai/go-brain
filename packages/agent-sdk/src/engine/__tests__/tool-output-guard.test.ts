import { describe, it, expect } from 'vitest';
import { guardToolOutput, TOOL_OUTPUT_MAX_CHARS, BINARY_REFUSAL } from '../tool-output-guard.js';

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);
const ZIP_MAGIC = 'PK' + String.fromCharCode(3, 4); // docx/xlsx/pptx/zip local file header

describe('guardToolOutput', () => {
  it('refuses content containing NUL bytes (a binary file read as utf8)', () => {
    const out = guardToolOutput('PK' + NUL + NUL + 'word/document.xml' + NUL + 'garbage');
    expect(out).toBe(BINARY_REFUSAL);
    expect(out).not.toContain(NUL);
  });

  it('refuses a leading zip/docx magic signature', () => {
    const out = guardToolOutput(ZIP_MAGIC + 'x'.repeat(500));
    expect(out).toBe(BINARY_REFUSAL);
  });

  it('refuses a leading %PDF magic signature', () => {
    const out = guardToolOutput('%PDF-1.7\n' + 'stream stuff '.repeat(50));
    expect(out).toBe(BINARY_REFUSAL);
  });

  it('refuses a high control/replacement-char ratio (mojibake binary)', () => {
    const out = guardToolOutput(REPLACEMENT.repeat(800));
    expect(out).toBe(BINARY_REFUSAL);
  });

  it('passes ordinary multi-line text through unchanged (tabs/newlines allowed)', () => {
    const text = 'hello\nworld\ttabs are fine\r\nsecond line';
    expect(guardToolOutput(text)).toBe(text);
  });

  it('truncates oversized text with a notice instead of refusing', () => {
    const big = 'a'.repeat(TOOL_OUTPUT_MAX_CHARS + 50);
    const out = guardToolOutput(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/truncat/i);
    expect(out.startsWith('aaaa')).toBe(true);
  });

  it('returns empty string unchanged', () => {
    expect(guardToolOutput('')).toBe('');
  });
});
