/**
 * Structured patch parsing and application.
 *
 * Supports classic unified diffs (`---`/`+++`, `@@ -a,b +c,d @@`) and the
 * lightweight `*** Begin Patch` format. Application validates every hunk
 * against the current file before writing; a mismatch is reported instead of
 * silently corrupting the file.
 */
export type PatchErrorCode =
  | 'invalid_patch'
  | 'context_mismatch'
  | 'ambiguous_context'
  | 'file_missing'
  | 'file_exists';

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PatchErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.details = details;
  }
}

export type PatchFileKind = 'update' | 'add' | 'delete';

export interface PatchHunk {
  /** 1-based original start line, or null for context-addressed hunks. */
  oldStart: number | null;
  oldCount: number;
  newStart: number | null;
  newCount: number;
  lines: string[];
}

export interface PatchFile {
  path: string;
  kind: PatchFileKind;
  hunks: PatchHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function cleanPath(value: string): string {
  return value.trim().split('\t')[0]!.replace(/^[ab]\//, '');
}

function isFileHeader(line: string): boolean {
  return line.startsWith('--- ') || line.startsWith('*** Update File:') ||
    line.startsWith('*** Add File:') || line.startsWith('*** Delete File:');
}

function collectHunkLines(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let index = start;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (HUNK_HEADER.test(line) || isFileHeader(line) || line.startsWith('*** End Patch') || line.startsWith('diff --git')) break;
    if (line.startsWith('\\ No newline')) continue;
    if (line === '') {
      // A trailing empty line is the newline that ends the patch text, not a
      // blank context line. Blank context lines are normally sent as " ".
      if (index === lines.length - 1) break;
      body.push(' ');
      continue;
    }
    if (line[0] === ' ' || line[0] === '+' || line[0] === '-') {
      body.push(line);
      continue;
    }
    break;
  }
  return { body, next: index };
}

function parseClassic(lines: string[]): PatchFile[] {
  const files: PatchFile[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith('--- ')) {
      index += 1;
      continue;
    }
    const oldPath = cleanPath(line.slice(4));
    const plus = lines[index + 1];
    if (!plus?.startsWith('+++ ')) {
      throw new PatchError('invalid_patch', 'A "+++" file header must follow the "---" header.', { line: index + 1 });
    }
    const newPath = cleanPath(plus.slice(4));
    index += 2;
    const hunks: PatchHunk[] = [];
    while (index < lines.length && !lines[index]!.startsWith('--- ')) {
      const header = HUNK_HEADER.exec(lines[index]!);
      if (!header) {
        if (lines[index]!.startsWith('diff --git')) break;
        index += 1;
        continue;
      }
      const collected = collectHunkLines(lines, index + 1);
      hunks.push({
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: collected.body,
      });
      index = collected.next;
    }
    const kind: PatchFileKind = oldPath === '/dev/null' ? 'add' : newPath === '/dev/null' ? 'delete' : 'update';
    const target = kind === 'add' ? newPath : oldPath;
    if (!target || target === '/dev/null') {
      throw new PatchError('invalid_patch', 'Patch file header is missing a target path.');
    }
    if (kind === 'update' && hunks.length === 0) {
      throw new PatchError('invalid_patch', `Update for ${target} contains no hunks.`, { path: target });
    }
    files.push({ path: target, kind, hunks });
  }
  return files;
}

function parseOpenCode(lines: string[]): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('*** Update File:') || line.startsWith('*** Add File:') || line.startsWith('*** Delete File:')) {
      if (current) files.push(current);
      const kind: PatchFileKind = line.startsWith('*** Add File:')
        ? 'add'
        : line.startsWith('*** Delete File:') ? 'delete' : 'update';
      const filePath = cleanPath(line.slice(line.indexOf(':') + 1));
      if (!filePath) throw new PatchError('invalid_patch', `A ${kind} patch is missing its file path.`);
      current = { path: filePath, kind, hunks: [] };
      // Add/delete sections are plain line lists; update sections use hunks.
      if (kind !== 'update') {
        const body: string[] = [];
        while (index + 1 < lines.length && !isFileHeader(lines[index + 1]!) && !lines[index + 1]!.startsWith('*** End Patch')) {
          body.push(lines[++index]!);
        }
        current.hunks.push({ oldStart: null, oldCount: 0, newStart: null, newCount: 0, lines: body });
      }
      continue;
    }
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) continue;
    if (!current || current.kind !== 'update') continue;
    if (line.startsWith('@@')) {
      current.hunks.push({ oldStart: null, oldCount: 0, newStart: null, newCount: 0, lines: [] });
      continue;
    }
    const hunk = current.hunks.at(-1);
    if (!hunk) {
      if (line.trim() === '') continue;
      throw new PatchError('invalid_patch', `Update for ${current.path} has content before its first "@@" hunk.`, { path: current.path });
    }
    if (line.startsWith('\\ No newline')) continue;
    if (line === '') hunk.lines.push(' ');
    else if (line[0] === ' ' || line[0] === '+' || line[0] === '-') hunk.lines.push(line);
    else hunk.lines.push(` ${line}`);
  }
  if (current) files.push(current);
  return files;
}

/** Parse a patch string into per-file operations. */
export function parsePatch(text: string): PatchFile[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.includes('*** Begin Patch') || normalized.includes('*** Update File:') ||
      normalized.includes('*** Add File:') || normalized.includes('*** Delete File:')) {
    return parseOpenCode(lines);
  }
  const files = parseClassic(lines);
  if (files.length === 0) {
    throw new PatchError('invalid_patch', 'No file sections were found. Supply a unified diff or a "*** Begin Patch" block.');
  }
  return files;
}

function expectedLines(hunk: PatchHunk): string[] {
  const result: string[] = [];
  for (const line of hunk.lines) {
    const marker = line[0];
    if (marker === '+') continue;
    if (marker === ' ' || marker === '-') result.push(line.slice(1));
  }
  return result;
}

function matchesAt(lines: string[], position: number, expected: string[]): boolean {
  if (position < 0 || position + expected.length > lines.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (lines[position + index] !== expected[index]) return false;
  }
  return true;
}

function findHunkPosition(lines: string[], hunk: PatchHunk, delta: number, filePath: string): number {
  const expected = expectedLines(hunk);
  if (expected.length === 0) {
    const position = hunk.oldStart === null ? lines.length : Math.max(0, hunk.oldStart - 1 + delta);
    return Math.min(lines.length, position);
  }
  const exact = hunk.oldStart === null ? -1 : Math.max(0, (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + delta);
  if (exact >= 0 && matchesAt(lines, exact, expected)) return exact;

  // Line numbers drift after earlier edits. Accept a unique nearby match, but
  // never guess when the same context appears more than once.
  const matches: number[] = [];
  const lower = hunk.oldStart === null ? 0 : Math.max(0, exact - 200);
  const upper = hunk.oldStart === null ? lines.length : Math.min(lines.length, exact + 200);
  for (let position = lower; position <= upper; position++) {
    if (matchesAt(lines, position, expected)) matches.push(position);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new PatchError('ambiguous_context', `Patch context for ${filePath} matches ${matches.length} locations.`, {
      path: filePath,
      lines: matches.slice(0, 8).map(position => position + 1),
    });
  }
  throw new PatchError(
    'context_mismatch',
    `Patch context does not match the current contents of ${filePath}.`,
    {
      path: filePath,
      expected: expected.slice(0, 8),
      hint: 'Re-read the file and regenerate the patch from its current contents.',
    },
  );
}

/** Apply every hunk to the original text and return the new contents. */
export function applyFilePatch(file: PatchFile, original: string): string {
  if (file.kind === 'add') {
    const content = file.hunks.flatMap(hunk => hunk.lines)
      .map(line => line[0] === '+' ? line.slice(1) : line.startsWith(' ') ? line.slice(1) : line)
      .join('\n');
    return content.endsWith('\n') ? content : `${content}\n`;
  }
  if (file.kind === 'delete') return '';
  if (file.hunks.length === 0) throw new PatchError('invalid_patch', `No hunks to apply for ${file.path}.`);

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  let delta = 0;
  let applied = 0;
  for (const hunk of file.hunks) {
    const position = findHunkPosition(lines, hunk, delta, file.path);
    const expected = expectedLines(hunk);
    const replacement: string[] = [];
    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === '-') continue;
      if (marker === '+' || marker === ' ') replacement.push(line.slice(1));
    }
    lines.splice(position, expected.length, ...replacement);
    delta += replacement.length - expected.length;
    applied += 1;
  }
  if (applied === 0) throw new PatchError('invalid_patch', `No hunks were applied for ${file.path}.`);
  return lines.join(eol);
}
