import type { ScannedLine } from './text-lines';

export interface ReadLedgerEntry {
  path: string;
  size: number;
  mtimeMs: number;
  lineCount?: number | null;
  hash?: string;
  ranges: Array<[number, number]>;
  lastReadAt: number;
}

export interface CachedRange {
  path: string;
  size: number;
  mtimeMs: number;
  startLine: number;
  endLine: number;
  lines: ScannedLine[];
  bytes: number;
  bytesScanned?: number;
  truncated: boolean;
  totalLines: number | null;
  nextOffset: number | null;
}

export interface ReadLedgerSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
  lineCount?: number | null;
  hash?: string;
  ranges: Array<[number, number]>;
  lastReadAt: string;
}

export interface ReadLedgerStats {
  reads: number;
  cacheHits: number;
  cacheMisses: number;
  diskReads: number;
  bytesReturned: number;
  bytesScanned: number;
}

const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_RANGES_PER_FILE = 40;

export class ReadLedger {
  private entries = new Map<string, ReadLedgerEntry>();
  private cache = new Map<string, CachedRange>();
  private resident = new Set<string>();
  private cacheBytes = 0;
  private maxCacheBytes: number;
  readonly stats: ReadLedgerStats = {
    reads: 0,
    cacheHits: 0,
    cacheMisses: 0,
    diskReads: 0,
    bytesReturned: 0,
    bytesScanned: 0,
  };

  constructor(maxCacheBytes = DEFAULT_MAX_CACHE_BYTES) {
    this.maxCacheBytes = Math.max(64 * 1024, maxCacheBytes);
  }

  static signature(path: string, size: number, mtimeMs: number, startLine: number, endLine: number): string {
    return `${path}@${size}:${mtimeMs}:${startLine}-${endLine}`;
  }

  entry(path: string): ReadLedgerEntry | undefined {
    return this.entries.get(path);
  }

  isCurrent(path: string, size: number, mtimeMs: number): boolean {
    const entry = this.entries.get(path);
    return Boolean(entry && entry.size === size && entry.mtimeMs === mtimeMs);
  }

  getCached(path: string, size: number, mtimeMs: number, startLine: number, limit: number): CachedRange | undefined {
    const key = ReadLedger.signature(path, size, mtimeMs, startLine, startLine);
    const cached = this.cache.get(key);
    if (!cached || (cached.truncated && cached.lines.length < limit)) {
      this.stats.cacheMisses += 1;
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, cached);
    this.stats.cacheHits += 1;
    if (cached.lines.length <= limit) return cached;
    const lines = cached.lines.slice(0, limit);
    const endLine = startLine + lines.length - 1;
    return {
      ...cached,
      lines,
      endLine,
      truncated: true,
      nextOffset: endLine + 1,
    };
  }

  putCached(entry: CachedRange): void {
    const key = ReadLedger.signature(entry.path, entry.size, entry.mtimeMs, entry.startLine, entry.startLine);
    const existing = this.cache.get(key);
    if (existing) {
      this.cacheBytes -= existing.bytes;
      this.cache.delete(key);
    }
    this.cache.set(key, entry);
    this.cacheBytes += entry.bytes;
    while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const evicted = this.cache.get(oldestKey);
      if (evicted) this.cacheBytes -= evicted.bytes;
      this.cache.delete(oldestKey);
    }
  }

  recordRead(
    path: string,
    version: { size: number; mtimeMs: number },
    range: { startLine: number; endLine: number },
    details: { lineCount?: number | null; hash?: string } = {},
  ): string {
    const entry = this.entries.get(path);
    const sameVersion = Boolean(entry && entry.size === version.size && entry.mtimeMs === version.mtimeMs);
    const ranges = sameVersion ? [...entry!.ranges] : [];
    if (range.endLine >= range.startLine) {
      ranges.push([range.startLine, range.endLine]);
      ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged: Array<[number, number]> = [];
      for (const next of ranges) {
        const last = merged[merged.length - 1];
        if (last && next[0] <= last[1] + 1) last[1] = Math.max(last[1], next[1]);
        else merged.push([next[0], next[1]]);
      }
      ranges.splice(0, ranges.length, ...merged);
      if (ranges.length > MAX_RANGES_PER_FILE) ranges.splice(0, ranges.length - MAX_RANGES_PER_FILE);
    }
    this.entries.set(path, {
      path,
      size: version.size,
      mtimeMs: version.mtimeMs,
      lineCount: details.lineCount ?? (sameVersion ? entry?.lineCount : undefined),
      hash: details.hash ?? (sameVersion ? entry?.hash : undefined),
      ranges,
      lastReadAt: Date.now(),
    });
    return ReadLedger.signature(path, version.size, version.mtimeMs, range.startLine, range.endLine);
  }

  noteRead(bytesReturned: number, bytesScanned: number, cacheHit: boolean): void {
    this.stats.reads += 1;
    this.stats.bytesReturned += bytesReturned;
    this.stats.bytesScanned += bytesScanned;
    if (!cacheHit) this.stats.diskReads += 1;
  }

  invalidate(path: string): void {
    this.entries.delete(path);
    const prefix = `${path}@`;
    for (const [key, cached] of [...this.cache.entries()]) {
      if (key.startsWith(prefix)) {
        this.cacheBytes -= cached.bytes;
        this.cache.delete(key);
      }
    }
    for (const signature of [...this.resident]) {
      if (signature.startsWith(prefix)) this.resident.delete(signature);
    }
  }

  clear(): void {
    this.entries.clear();
    this.cache.clear();
    this.resident.clear();
    this.cacheBytes = 0;
    this.stats.reads = 0;
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
    this.stats.diskReads = 0;
    this.stats.bytesReturned = 0;
    this.stats.bytesScanned = 0;
  }

  setResidentSignatures(signatures: Set<string>): void {
    this.resident = new Set(signatures);
  }

  isResident(signature: string): boolean {
    return this.resident.has(signature);
  }

  snapshot(limit = 40): ReadLedgerSnapshot[] {
    return [...this.entries.values()]
      .sort((a, b) => b.lastReadAt - a.lastReadAt)
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map(entry => ({
        path: entry.path,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        lineCount: entry.lineCount,
        hash: entry.hash,
        ranges: entry.ranges.slice(-MAX_RANGES_PER_FILE),
        lastReadAt: new Date(entry.lastReadAt).toISOString(),
      }));
  }

  cachedRangeCount(): number {
    return this.cache.size;
  }
}
