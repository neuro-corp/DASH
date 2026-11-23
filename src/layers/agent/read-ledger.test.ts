import { describe, expect, it } from 'bun:test';
import { ReadLedger, type CachedRange } from './read-ledger';

const version = { size: 100, mtimeMs: 1234 };

function cached(overrides: Partial<CachedRange> = {}): CachedRange {
  return {
    path: 'src/a.ts',
    size: version.size,
    mtimeMs: version.mtimeMs,
    startLine: 1,
    endLine: 3,
    lines: [
      { line: 1, text: 'a' },
      { line: 2, text: 'b' },
      { line: 3, text: 'c' },
    ],
    bytes: 6,
    truncated: true,
    totalLines: null,
    nextOffset: 4,
    ...overrides,
  };
}

describe('read ledger', () => {
  it('serves a cached range and slices it to the requested limit', () => {
    const ledger = new ReadLedger();
    ledger.putCached(cached());
    const hit = ledger.getCached('src/a.ts', version.size, version.mtimeMs, 1, 2);
    expect(hit?.lines.map(line => line.text)).toEqual(['a', 'b']);
    expect(hit?.truncated).toBe(true);
    expect(hit?.nextOffset).toBe(3);
    expect(ledger.stats.cacheHits).toBe(1);
  });

  it('misses when a truncated cache cannot satisfy a larger request', () => {
    const ledger = new ReadLedger();
    ledger.putCached(cached());
    expect(ledger.getCached('src/a.ts', version.size, version.mtimeMs, 1, 10)).toBeUndefined();
    expect(ledger.stats.cacheMisses).toBe(1);
  });

  it('serves a complete short-file range without rereading', () => {
    const ledger = new ReadLedger();
    ledger.putCached(cached({ endLine: 3, truncated: false, totalLines: 3, nextOffset: null }));
    const hit = ledger.getCached('src/a.ts', version.size, version.mtimeMs, 1, 200);
    expect(hit?.lines).toHaveLength(3);
    expect(hit?.truncated).toBe(false);
  });

  it('invalidates a changed file and tracks resident signatures', () => {
    const ledger = new ReadLedger();
    const signature = ledger.recordRead('src/a.ts', version, { startLine: 1, endLine: 3 }, { lineCount: 3 });
    ledger.putCached(cached());
    ledger.setResidentSignatures(new Set([signature]));
    expect(ledger.isResident(signature)).toBe(true);

    ledger.invalidate('src/a.ts');
    expect(ledger.entry('src/a.ts')).toBeUndefined();
    expect(ledger.getCached('src/a.ts', version.size, version.mtimeMs, 1, 2)).toBeUndefined();
    expect(ledger.isResident(signature)).toBe(false);
  });

  it('records reads and snapshots metadata only', () => {
    const ledger = new ReadLedger();
    ledger.recordRead('src/a.ts', version, { startLine: 1, endLine: 3 }, { lineCount: 3, hash: 'abc' });
    ledger.recordRead('src/a.ts', version, { startLine: 2, endLine: 5 });
    ledger.noteRead(6, 100, false);
    const [entry] = ledger.snapshot();
    expect(entry?.path).toBe('src/a.ts');
    expect(entry?.hash).toBe('abc');
    expect(entry?.ranges).toEqual([[1, 5]]);
    expect(ledger.stats).toMatchObject({ reads: 1, diskReads: 1, bytesReturned: 6, bytesScanned: 100 });
  });
});
