import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(os.homedir(), '.dash');
const CACHE_PATH = path.join(CONFIG_DIR, 'update_cache.json');
const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', 'package.json');
const PACKAGE_NAME = '@neuro.corp/dash';
const REGISTRY_URL = 'https://registry.npmjs.org/@neuro.corp%2Fdash/latest';
const UPDATE_CHECK_ENV = 'DASH_SKIP_UPDATE_CHECK';

let notifiedThisSession = false;

export function isUpdateCheckDisabled(): boolean {
  return process.env[UPDATE_CHECK_ENV] === '1' || process.env[UPDATE_CHECK_ENV] === 'true';
}

export function getInstalledVersion(): string {
  const candidates: string[] = [];
  if (path.basename(process.execPath).replace(/\.exe$/i, '') === 'dash') {
    candidates.push(path.join(path.dirname(process.execPath), '..', 'package.json'));
  }
  candidates.push(path.resolve(__dirname, '..', 'package.json'));
  candidates.push(path.resolve(process.cwd(), 'package.json'));
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const pkg = JSON.parse(raw);
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

function parseSemver(v: string) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  };
}

export function compareVersions(a: string, b: string): number {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A || !B) {
    // fallback to string compare
    return a.localeCompare(b);
  }
  if (A.major !== B.major) return A.major - B.major;
  if (A.minor !== B.minor) return A.minor - B.minor;
  if (A.patch !== B.patch) return A.patch - B.patch;
  // prerelease handling: no prerelease > prerelease
  if (A.prerelease === B.prerelease) return 0;
  if (!A.prerelease) return 1;
  if (!B.prerelease) return -1;
  // both have prerelease, compare lexicographically
  return A.prerelease.localeCompare(B.prerelease);
}

function loadCache(): { lastChecked?: number; latestVersion?: string } | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data.lastChecked === 'number' && typeof data.latestVersion === 'string') {
      return data;
    }
  } catch {}
  return null;
}

function saveCache(latestVersion: string) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const data = { lastChecked: Date.now(), latestVersion };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data), 'utf8');
  } catch {}
}

export async function fetchLatestVersion(): Promise<string | null> {
  if (isUpdateCheckDisabled()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.version === 'string') {
      return data.version;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForUpdate(options: { force?: boolean } = {}): Promise<{ hasUpdate: boolean; installed: string; latest: string | null }> {
  if (isUpdateCheckDisabled()) {
    return { hasUpdate: false, installed: getInstalledVersion(), latest: null };
  }
  const installed = getInstalledVersion();
  const cache = loadCache();
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  let latestVersion: string | null = null;
  let useCache = false;

  if (!options.force && cache && cache.latestVersion && typeof cache.lastChecked === 'number' && now - cache.lastChecked < ONE_DAY) {
    latestVersion = cache.latestVersion;
    useCache = true;
  }

  if (!useCache) {
    latestVersion = await fetchLatestVersion();
    if (latestVersion) saveCache(latestVersion);
  }

  if (!latestVersion) {
    // A forced/manual check must reflect the live registry response. Never
    // report a cached version as current when the registry could not be reached.
    if (!options.force && cache?.latestVersion) latestVersion = cache.latestVersion;
    else return { hasUpdate: false, installed, latest: null };
  }

  const cmp = compareVersions(installed, latestVersion);
  const hasUpdate = cmp < 0;
  return { hasUpdate, installed, latest: latestVersion };
}

export function resetSessionNotification() {
  notifiedThisSession = false;
}

export function shouldNotify(): boolean {
  return !notifiedThisSession;
}

export function markNotified() {
  notifiedThisSession = true;
}
