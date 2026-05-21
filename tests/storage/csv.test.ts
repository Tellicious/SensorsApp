import { describe, it, expect } from 'vitest';
import { csvEscape } from '../../src/lib/storage/csv';

describe('csvEscape', () => {
  it('null and undefined become empty strings', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('passes plain values through unchanged', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(3.14)).toBe('3.14');
    expect(csvEscape(true)).toBe('true');
  });

  it('wraps values with commas in quotes', () => {
    expect(csvEscape('a,b,c')).toBe('"a,b,c"');
  });

  it('wraps values with newlines in quotes', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('doubles internal quotes and wraps', () => {
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('handles combined cases', () => {
    expect(csvEscape('a, "b", c')).toBe('"a, ""b"", c"');
  });

  it('empty string is left as empty', () => {
    expect(csvEscape('')).toBe('');
  });

  it('numeric zero is "0", not empty', () => {
    expect(csvEscape(0)).toBe('0');
  });
});
