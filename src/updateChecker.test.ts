import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compareVersions, isUpdateCheckDisabled, getInstalledVersion, checkForUpdate } from './updateChecker';

const CACHE_PATH = path.join(os.homedir(), '.dash', 'update_cache.json');
const CONFIG_DIR = path.join(os.homedir(), '.dash');

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('detects newer major', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0);
  });
  it('detects newer minor', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
  });
  it('detects newer patch', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });
  it('stable > prerelease', () => {
    expect(compareVersions('1.2.3', '1.2.3-alpha')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-alpha', '1.2.3')).toBeLessThan(0);
  });
  it('prerelease comparison lexicographically', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3-alpha')).toBeGreaterThan(0);
  });
});

describe('isUpdateCheckDisabled', () => {
  const original = process.env.DASH_SKIP_UPDATE_CHECK;
  afterEach(() => {
    if (original === undefined) delete process.env.DASH_SKIP_UPDATE_CHECK;
    else process.env.DASH_SKIP_UPDATE_CHECK = original;
  });
  it('disabled when env is 1', () => {
    process.env.DASH_SKIP_UPDATE_CHECK = '1';
    expect(isUpdateCheckDisabled()).toBe(true);
  });
  it('disabled when env is true', () => {
    process.env.DASH_SKIP_UPDATE_CHECK = 'true';
    expect(isUpdateCheckDisabled()).toBe(true);
  });
  it('enabled otherwise', () => {
    delete process.env.DASH_SKIP_UPDATE_CHECK;
    expect(isUpdateCheckDisabled()).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    // clean cache
    try { if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH); } catch {}
    try { if (fs.existsSync(CONFIG_DIR)) { const files = fs.readdirSync(CONFIG_DIR); files.forEach(f => fs.unlinkSync(path.join(CONFIG_DIR, f))); } } catch {}
    delete process.env.DASH_SKIP_UPDATE_CHECK;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    try { if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH); } catch {}
  });

  it('detects newer version', async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ version: '1.1.9' })
    }) as any);
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(true);
    expect(result.latest).toBe('1.1.9');
    expect(result.installed).toBe('1.1.8');
  });

  it('no update when equal', async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ version: '1.1.8' })
    }) as any);
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(false);
  });

  it('handles network error gracefully', async () => {
    global.fetch = mock(async () => { throw new Error('network'); }) as any;
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(false);
    expect(result.latest).toBeNull();
  });

  it('skips check when disabled', async () => {
    process.env.DASH_SKIP_UPDATE_CHECK = '1';
    global.fetch = mock(() => { throw new Error('should not fetch'); }) as any;
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(false);
    expect(result.latest).toBeNull();
  });

  it('uses cache within 24h', async () => {
    // prime cache
    const cacheData = { lastChecked: Date.now(), latestVersion: '1.2.0' };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData), 'utf8');
    let fetchCalled = false;
    global.fetch = mock(async () => { fetchCalled = true; return { ok:true, json: async()=>({version:'9.9.9'}) } as any; });
    const result = await checkForUpdate();
    expect(fetchCalled).toBe(false);
    expect(result.latest).toBe('1.2.0');
    expect(result.hasUpdate).toBe(true);
  });

  it('bypasses cache when a fresh check is requested', async () => {
    const cacheData = { lastChecked: Date.now(), latestVersion: '1.1.8' };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData), 'utf8');
    let fetchCalled = false;
    global.fetch = mock(async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ version: '1.1.9' }) } as any;
    });

    const result = await checkForUpdate({ force: true });

    expect(fetchCalled).toBe(true);
    expect(result.latest).toBe('1.1.9');
    expect(result.hasUpdate).toBe(true);
  });

  it('does not report up to date from stale cache when a fresh check is offline', async () => {
    const cacheData = { lastChecked: Date.now(), latestVersion: '1.1.8' };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData), 'utf8');
    global.fetch = mock(async () => { throw new Error('offline'); }) as any;

    const result = await checkForUpdate({ force: true });

    expect(result.hasUpdate).toBe(false);
    expect(result.latest).toBeNull();
  });

  it('prerelease not treated as newer than stable', async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ version: '1.1.8-alpha' })
    }) as any);
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(false); // stable 1.1.8 is newer than prerelease
  });
});
