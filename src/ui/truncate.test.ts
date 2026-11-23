import { describe, expect, it } from 'bun:test';
import { truncateText } from './truncate';

describe('truncateText', () => {
  it('returns empty string for zero/negative width', () => {
    expect(truncateText('anything', 0)).toBe('');
    expect(truncateText('anything', -3)).toBe('');
  });

  it('never exceeds the available width, adding an ellipsis when clipping', () => {
    expect(truncateText('short', 20)).toBe('short');
    const clipped = truncateText('a'.repeat(50), 20);
    expect(clipped.length).toBe(20);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('keeps the ellipsis inside the budget for single-char width', () => {
    expect(truncateText('abc', 1)).toBe('…');
  });
});
