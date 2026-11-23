import { describe, expect, it } from 'bun:test';
import { PatchError, applyFilePatch, parsePatch } from './patch';

const ORIGINAL = 'line one\nline two\nline three\n';

describe('structured patches', () => {
  it('applies a classic unified diff update', () => {
    const [file] = parsePatch([
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-line two',
      '+line 2',
      ' line three',
      '',
    ].join('\n'));
    expect(file?.path).toBe('src/example.ts');
    expect(file?.kind).toBe('update');
    const result = applyFilePatch(file!, ORIGINAL);
    expect(result).toBe('line one\nline 2\nline three\n');
  });

  it('creates files from a diff against /dev/null', () => {
    const [file] = parsePatch([
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1,2 @@',
      '+first line',
      '+second line',
      '',
    ].join('\n'));
    expect(file?.kind).toBe('add');
    expect(file?.path).toBe('docs/new.md');
    expect(applyFilePatch(file!, '')).toBe('first line\nsecond line\n');
  });

  it('deletes files from a diff against /dev/null', () => {
    const [file] = parsePatch([
      '--- a/obsolete.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-line one',
      '',
    ].join('\n'));
    expect(file?.kind).toBe('delete');
    expect(file?.path).toBe('obsolete.ts');
    expect(applyFilePatch(file!, ORIGINAL)).toBe('');
  });

  it('applies the *** Begin Patch format', () => {
    const [file] = parsePatch([
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@',
      '-line two',
      '+line two updated',
      '*** End Patch',
    ].join('\n'));
    expect(file?.path).toBe('src/example.ts');
    expect(applyFilePatch(file!, ORIGINAL)).toContain('line two updated');
  });

  it('adds and deletes files in the *** Begin Patch format', () => {
    const [added, deleted] = parsePatch([
      '*** Begin Patch',
      '*** Add File: notes/todo.md',
      '+alpha',
      '+beta',
      '*** Delete File: src/example.ts',
      '*** End Patch',
    ].join('\n'));
    expect(added?.kind).toBe('add');
    expect(applyFilePatch(added!, '')).toBe('alpha\nbeta\n');
    expect(deleted?.kind).toBe('delete');
    expect(applyFilePatch(deleted!, ORIGINAL)).toBe('');
  });

  it('validates hunk context and reports a mismatch instead of corrupting the file', () => {
    const [file] = parsePatch([
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,1 +1,1 @@',
      '-not in the file',
      '+replacement',
      '',
    ].join('\n'));
    expect(() => applyFilePatch(file!, ORIGINAL)).toThrow(PatchError);
    try {
      applyFilePatch(file!, ORIGINAL);
    } catch (error) {
      expect((error as PatchError).code).toBe('context_mismatch');
      expect((error as PatchError).details?.path).toBe('src/example.ts');
    }
  });

  it('refuses to guess when identical context appears more than once', () => {
    const original = 'const x = 1;\nconst x = 1;\n';
    const [file] = parsePatch([
      '*** Begin Patch',
      '*** Update File: repeated.ts',
      '@@',
      '-const x = 1;',
      '+const x = 2;',
      '*** End Patch',
    ].join('\n'));
    try {
      applyFilePatch(file!, original);
      throw new Error('Expected an ambiguous_context error.');
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      expect((error as PatchError).code).toBe('ambiguous_context');
    }
  });

  it('supports several hunks in one file and tracks line drift', () => {
    const original = 'a\nb\nc\nd\ne\nf\n';
    const [file] = parsePatch([
      '--- a/multi.txt',
      '+++ b/multi.txt',
      '@@ -1,1 +1,2 @@',
      '-a',
      '+a',
      '+inserted',
      '@@ -4,1 +5,1 @@',
      '-d',
      '+delta',
      '',
    ].join('\n'));
    expect(applyFilePatch(file!, original)).toBe('a\ninserted\nb\nc\ndelta\ne\nf\n');
  });

  it('rejects malformed patches', () => {
    expect(() => parsePatch('this is not a patch')).toThrow(PatchError);
    expect(() => parsePatch('--- a/file.ts\nno plus header')).toThrow(PatchError);
    expect(() => parsePatch('--- a/file.ts\n+++ b/file.ts\n')).toThrow(PatchError);
  });
});
