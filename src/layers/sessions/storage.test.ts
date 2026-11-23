import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSession, loadSessions, saveSession, pruneEmptySessions, hasUserMessage } from './storage';

const temporaryDirectories: string[] = [];

function createStorePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sessions-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'private', 'sessions.json');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('private chat session storage', () => {
  it('creates, saves, reloads, and updates chat sessions', () => {
    const filePath = createStorePath();
    const session = createSession();
    session.title = 'Workspace question';
    session.messages = [{ role: 'user', content: 'What files are here?' }, { role: 'assistant', content: 'I will inspect them.' }];
    session.conversation = [{ role: 'user', content: 'What files are here?' }];

    saveSession(session, filePath);
    expect(loadSessions(filePath)).toEqual([session]);

    const updated = { ...session, updatedAt: new Date(Date.now() + 1000).toISOString(), messages: [...session.messages, { role: 'assistant' as const, content: 'Here is the summary.' }] };
    saveSession(updated, filePath);
    expect(loadSessions(filePath)).toEqual([updated]);
  });

  it('keeps multiple sessions newest-first and ignores invalid storage', () => {
    const filePath = createStorePath();
    const older = createSession();
    older.updatedAt = '2026-01-01T00:00:00.000Z';
    older.messages = [{ role: 'user', content: 'older question' }];
    const newer = createSession();
    newer.updatedAt = '2026-02-01T00:00:00.000Z';
    newer.messages = [{ role: 'user', content: 'newer question' }];
    saveSession(older, filePath);
    saveSession(newer, filePath);
    expect(loadSessions(filePath).map(session => session.id)).toEqual([newer.id, older.id]);

    fs.writeFileSync(filePath, 'not json', 'utf8');
    expect(loadSessions(filePath)).toEqual([]);
  });

  it('drops empty sessions when loading and prunes them from storage', () => {
    const filePath = createStorePath();
    const filled = createSession();
    filled.messages = [{ role: 'user', content: 'hello' }];
    const empty = createSession();
    saveSession(empty, filePath);
    saveSession(filled, filePath);

    expect(loadSessions(filePath).map(session => session.id)).toEqual([filled.id]);

    const pruned = pruneEmptySessions(filePath);
    expect(pruned.map(session => session.id)).toEqual([filled.id]);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { id: string }[];
    expect(raw.map(session => session.id)).toEqual([filled.id]);
    expect(hasUserMessage(filled)).toBe(true);
  });
});
