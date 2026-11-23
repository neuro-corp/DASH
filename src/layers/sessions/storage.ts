import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NvidiaChatMessage } from '../../providers/nvidia';
import type { Message } from '../../ui/MessageList';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  conversation: NvidiaChatMessage[];
}

const SESSION_DIR = path.join(os.homedir(), '.dash');
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');

export function createSession(): ChatSession {
  const now = new Date().toISOString();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    messages: [],
    conversation: [],
  };
}

function parseSessionsFile(filePath: string): ChatSession[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((session): session is ChatSession =>
      Boolean(session)
      && typeof session === 'object'
      && typeof session.id === 'string'
      && typeof session.title === 'string'
      && typeof session.createdAt === 'string'
      && typeof session.updatedAt === 'string'
      && Array.isArray(session.messages)
      && Array.isArray(session.conversation),
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function hasUserMessage(session: ChatSession): boolean {
  return Array.isArray(session.messages) && session.messages.some(message => message.role === 'user');
}

export function loadSessions(filePath = SESSION_FILE): ChatSession[] {
  return parseSessionsFile(filePath).filter(hasUserMessage);
}

export function deleteSession(sessionId: string, filePath = SESSION_FILE): boolean {
  const sessions = loadSessions(filePath);
  if (!sessions.some(session => session.id === sessionId)) return false;
  const remaining = sessions.filter(session => session.id !== sessionId);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(remaining, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return true;
}

export function pruneEmptySessions(filePath = SESSION_FILE): ChatSession[] {
  const sessions = parseSessionsFile(filePath);
  if (sessions.every(hasUserMessage)) return sessions;
  const remaining = sessions.filter(hasUserMessage);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(remaining, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return remaining;
}

export function saveSession(session: ChatSession, filePath = SESSION_FILE): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Permission tightening may be unsupported. */ }

  const sessions = loadSessions(filePath);
  const updated = [session, ...sessions.filter(item => item.id !== session.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temporaryPath, 0o600); } catch { /* Permission tightening may be unsupported. */ }
  fs.renameSync(temporaryPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Permission tightening may be unsupported. */ }
}