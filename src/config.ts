import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.dash');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Simple key derived from home path – for demo purposes
function getKey() {
  const salt = os.homedir();
  return crypto.createHash('sha256').update(salt).digest();
}

export function encrypt(text: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(data: string) {
  const buf = Buffer.from(data, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

const DEFAULT_CONFIG = () => ({ providers: { nvidia: { apiKey: '', model: '' } } });

function forEachProviderApiKey(cfg: any, visit: (entry: { apiKey?: string }) => void) {
  const providers = cfg?.providers;
  if (!providers || typeof providers !== 'object') return;
  for (const entry of Object.values(providers)) {
    if (entry && typeof entry === 'object' && typeof (entry as { apiKey?: unknown }).apiKey === 'string') {
      visit(entry as { apiKey?: string });
    }
  }
}

function forEachMcpSecret(cfg: any, visit: (entry: Record<string, string>, key: string) => void) {
  const servers = cfg?.mcp?.servers;
  if (!Array.isArray(servers)) return;
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;
    for (const field of ['env', 'headers']) {
      const values = server[field];
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') visit(values as Record<string, string>, key);
      }
    }
  }
}

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_CONFIG();
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    forEachProviderApiKey(cfg, entry => {
      if (!entry.apiKey) return;
      try {
        entry.apiKey = decrypt(entry.apiKey);
      } catch {
        // Older configs stored some provider keys as plaintext; keep them as-is.
      }
    });
    forEachMcpSecret(cfg, (entry, key) => {
      try {
        entry[key] = decrypt(entry[key]!);
      } catch {
        // Keep values from older plaintext configurations readable.
      }
    });
    return cfg;
  } catch {
    return DEFAULT_CONFIG();
  }
}

export function saveConfig(cfg: any) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const toSave = JSON.parse(JSON.stringify(cfg));
  forEachProviderApiKey(toSave, entry => {
    if (entry.apiKey) entry.apiKey = encrypt(entry.apiKey);
  });
  forEachMcpSecret(toSave, (entry, key) => {
    if (entry[key]) entry[key] = encrypt(entry[key]!);
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
}
