import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentToolRegistry, agentTools, executeAgentTool, selectAgentToolsForTask, type AgentTodo } from './tools';
import { ReadLedger } from './read-ledger';
import { TaskTracker } from './taskstate';

let workspaceRoot: string;
let todos: AgentTodo[] = [];
let approval = true;
let approvalRequests: string[] = [];

const context = {
  get workspaceRoot() { return workspaceRoot; },
  approve: async (toolName: string, summary: string) => {
    approvalRequests.push(`${toolName}: ${summary}`);
    return approval;
  },
  ask: async (question: string, options?: string[]) => `${question}: ${options?.[0] ?? 'answered'}`,
  readSessionActivity: (sessionId: string | undefined, limit: number) => JSON.stringify({ sessionId: sessionId ?? 'current', limit }),
  updateTodos: (value: AgentTodo[]) => { todos = value; },
};

async function toolError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error as any;
  }
  throw new Error('Expected the tool call to reject.');
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-agent-tools-'));
  todos = [];
  approval = true;
  approvalRequests = [];
  await fs.mkdir(path.join(workspaceRoot, 'src', 'layers'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src', 'layers', 'sample.ts'), 'const greeting = "hello";\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('workspace agent tools', () => {
  it('uses a canonical registry with validated arguments and controlled unknown-tool failures', async () => {
    expect(agentToolRegistry.getAll()).toHaveLength(agentTools.length);
    expect(new Set(agentTools.map(tool => tool.function.name)).size).toBe(agentTools.length);
    for (const tool of agentTools) expect(agentToolRegistry.has(tool.function.name)).toBe(true);
    const invalid = await agentToolRegistry.execute('read_file', '{"limit":0}', context);
    expect(invalid).toMatchObject({ success: false, toolName: 'read_file', errorCode: 'invalid_arguments' });
    const unknown = await agentToolRegistry.execute('made_up_tool', '{}', context);
    expect(unknown).toMatchObject({ success: false, toolName: 'made_up_tool', errorCode: 'unknown_tool' });
    const unknownError = await toolError(executeAgentTool('made_up_tool', '{}', context));
    expect(unknownError.code).toBe('unknown_tool');
  });

  it('discovers ranked code locations, file outlines, and symbol references', async () => {
    const home = 'src/pages/Home.tsx';
    await fs.mkdir(path.dirname(path.join(workspaceRoot, home)), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, home), [
      'import { Search as SearchIcon } from "lucide-react";',
      'export function Home() {',
      '  return <main><SearchIcon /></main>;',
      '}',
    ].join('\n'), 'utf8');

    const found = JSON.parse(await executeAgentTool('codebase_search', JSON.stringify({ query: 'Where is the search icon on the home page?', maxResults: 5 }), context));
    expect(found.results[0]).toMatchObject({ filePath: home, matchLine: 3, symbol: 'SearchIcon', matchType: 'component_usage' });
    expect(found.results[0].snippet).toContain('3:   return <main><SearchIcon /></main>;');
    const cachedSearch = JSON.parse(await executeAgentTool('codebase_search', JSON.stringify({ query: 'Where is the search icon on the home page?', maxResults: 5 }), context));
    expect(cachedSearch.cached).toBe(true);
    const cachedExecution = await agentToolRegistry.execute('codebase_search', JSON.stringify({ query: 'Where is the search icon on the home page?', maxResults: 5 }), context);
    expect(cachedExecution.metadata.cached).toBe(true);

    const outline = JSON.parse(await executeAgentTool('get_file_outline', JSON.stringify({ path: home }), context));
    expect(outline.symbols).toContainEqual({ name: 'Home', kind: 'component', startLine: 2, endLine: 4 });
    expect(outline.imports).toContainEqual({ source: 'lucide-react', line: 1 });

    const symbol = JSON.parse(await executeAgentTool('find_symbol', JSON.stringify({ name: 'Home', scope: ['src/pages'] }), context));
    expect(symbol.declarations[0]).toMatchObject({ filePath: home, line: 2 });

    const verification = JSON.parse(await executeAgentTool('verify_changes', JSON.stringify({ files: [home], expected: [{ path: home, contains: '<SearchIcon />' }] }), context));
    expect(verification.success).toBe(true);
    const emptyVerification = JSON.parse(await executeAgentTool('verify_changes', '{}', context));
    expect(emptyVerification.success).toBe(false);

    await executeAgentTool('edit_file', JSON.stringify({ path: home, old_text: '<SearchIcon />', new_text: '<FindIcon />' }), context);
    const refreshedSearch = JSON.parse(await executeAgentTool('codebase_search', JSON.stringify({ query: 'Where is the search icon on the home page?', maxResults: 5 }), context));
    expect(refreshedSearch.cached).toBe(false);
  });

  it('sends a reduced core schema set and adds specialist tools for requested tasks', () => {
    const core = selectAgentToolsForTask(agentTools, 'Fix the bug in this file.');
    const coreNames = core.map(tool => tool.function.name);
    expect(coreNames).toContain('read_file');
    expect(coreNames).toContain('edit_file');
    expect(coreNames).toContain('grep');
    expect(coreNames).toContain('apply_patch');
    expect(coreNames).not.toContain('web_search');
    expect(coreNames.length).toBeLessThan(agentTools.length / 2);

    const research = selectAgentToolsForTask(agentTools, 'Research the latest information on this website.');
    const researchNames = research.map(tool => tool.function.name);
    expect(researchNames).toContain('web_search');
    expect(researchNames).toContain('web_fetch');

    const gitTask = selectAgentToolsForTask(agentTools, 'Create a git commit on a new branch.');
    expect(gitTask.map(tool => tool.function.name)).toContain('git_tool');

    const largeTask = selectAgentToolsForTask(agentTools, 'Build a complete website with 10 pages, forms, and responsive layouts.');
    const largeNames = largeTask.map(tool => tool.function.name);
    expect(largeNames).toContain('get_project_map');
    expect(largeNames).toContain('update_task_plan');
    expect(largeNames).toContain('get_diagnostics');
    expect(largeNames).not.toContain('web_search');

    const researchWebsite = selectAgentToolsForTask(agentTools, 'Research the latest information for this website URL.');
    expect(researchWebsite.map(tool => tool.function.name)).toContain('web_search');
  });

  it('keeps how/where source questions focused and read-only unless implementation is explicit', () => {
    const guidanceNames = selectAgentToolsForTask(
      agentTools,
      'How can I edit the background color in all pop-up boxes?',
    ).map(tool => tool.function.name);
    expect(guidanceNames).toContain('search_files');
    expect(guidanceNames).toContain('read_file');
    expect(guidanceNames).toContain('codebase_search');
    expect(guidanceNames).toContain('find_symbol');
    expect(guidanceNames).not.toContain('get_project_map');
    expect(guidanceNames).not.toContain('glob');
    expect(guidanceNames).not.toContain('write_file');
    expect(guidanceNames).not.toContain('edit_file');
    expect(guidanceNames).not.toContain('todo_write');
    expect(guidanceNames).not.toContain('run_command');

    const implementationNames = selectAgentToolsForTask(
      agentTools,
      'How can I edit the popup color? Please change it for me.',
    ).map(tool => tool.function.name);
    expect(implementationNames).toContain('edit_file');
    expect(implementationNames).toContain('write_file');
  });

  it('reads, lists, searches, finds, and reports workspace files', async () => {
    const read = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'src/layers/sample.ts' }), context));
    expect(read.content).toContain('hello');

    const listed = JSON.parse(await executeAgentTool('list_files', JSON.stringify({ path: '.', recursive: true }), context));
    expect(listed.entries.some((entry: { name: string }) => entry.name === 'src/layers/sample.ts')).toBe(true);

    const found = JSON.parse(await executeAgentTool('find_files', JSON.stringify({ pattern: '**/*.ts' }), context));
    expect(found.files).toContain('src/layers/sample.ts');

    const searched = JSON.parse(await executeAgentTool('search_files', JSON.stringify({ query: 'greeting' }), context));
    expect(searched.matches[0].path).toBe('src/layers/sample.ts');

    const info = JSON.parse(await executeAgentTool('get_file_info', JSON.stringify({ path: 'src/layers/sample.ts' }), context));
    expect(info.type).toBe('file');
    expect(info.size).toBeGreaterThan(0);
  });

  it('reads full files and specific line ranges from read_file', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'lines.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'empty.txt'), '', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'no-newline.txt'), 'single', 'utf8');

    const full = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt' }), context));
    expect(full.content).toContain('five');
    expect(full.lines).toBeUndefined();

    const offsetOnly = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt', offset: 3 }), context));
    expect(offsetOnly.startLine).toBe(3);
    expect(offsetOnly.totalLines).toBe(5);
    expect(offsetOnly.lines).toEqual([
      { line: 3, text: 'three' },
      { line: 4, text: 'four' },
      { line: 5, text: 'five' },
    ]);
    expect(offsetOnly.truncated).toBe(false);

    const ranged = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt', offset: 2, limit: 2 }), context));
    expect(ranged.startLine).toBe(2);
    expect(ranged.totalLines).toBe(5);
    expect(ranged.truncated).toBe(true);
    expect(ranged.lines).toEqual([
      { line: 2, text: 'two' },
      { line: 3, text: 'three' },
    ]);

    const limitOnly = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt', limit: 2 }), context));
    expect(limitOnly.startLine).toBe(1);
    expect(limitOnly.lines).toEqual([
      { line: 1, text: 'one' },
      { line: 2, text: 'two' },
    ]);

    const atEnd = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt', offset: 5, limit: 10 }), context));
    expect(atEnd.lines).toEqual([{ line: 5, text: 'five' }]);
    expect(atEnd.totalLines).toBe(5);

    const beyond = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt', offset: 99, limit: 5 }), context));
    expect(beyond.totalLines).toBe(5);
    expect(beyond.lines).toEqual([]);

    const empty = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'empty.txt', offset: 1, limit: 5 }), context));
    expect(empty.totalLines).toBe(0);
    expect(empty.lines).toEqual([]);

    const single = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'no-newline.txt', offset: 1, limit: 3 }), context));
    expect(single.totalLines).toBe(1);
    expect(single.lines).toEqual([{ line: 1, text: 'single' }]);

    await expect(executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt', offset: 0 }), context)).rejects.toThrow('offset');
    await expect(executeAgentTool('read_file', JSON.stringify({ path: 'lines.txt', limit: 1.5 }), context)).rejects.toThrow('limit');
  });

  it('reads multiple bounded files with independent errors and continuation offsets', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'first.txt'), 'first file\n', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'long.txt'), '0123456789\n'.repeat(1000), 'utf8');
    const result = JSON.parse(await executeAgentTool('read_many', JSON.stringify({
      files: [
        { path: 'first.txt' },
        { path: 'long.txt', offset: 1, limit: 1000 },
        { path: 'missing.txt' },
      ],
    }), context));

    expect(result.files).toHaveLength(3);
    expect(result.files[0]).toMatchObject({ success: true, path: 'first.txt', content: 'first file\n' });
    expect(result.files[0].hash).toBeString();
    expect(result.files[1].success).toBe(true);
    expect(result.files[1].contentTruncated).toBe(true);
    expect(result.files[1].nextOffset).toBeGreaterThan(1);
    expect(result.files[2]).toMatchObject({ success: false, path: 'missing.txt', errorCode: 'file_not_found' });
    expect(JSON.stringify(result).length).toBeLessThan(8_000);
  });

  it('reuses a cached read range and invalidates it after an edit', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'cache.txt'), 'one\ntwo\nthree\n', 'utf8');
    const ledger = new ReadLedger();
    const cachedContext = { ...context, readLedger: ledger };
    const args = JSON.stringify({ path: 'cache.txt', offset: 1, limit: 2 });

    const first = JSON.parse(await executeAgentTool('read_file', args, cachedContext));
    expect(first.fromCache).toBe(false);
    const second = JSON.parse(await executeAgentTool('read_file', args, cachedContext));
    expect(second.fromCache).toBe(true);
    expect(second.lines).toEqual(first.lines);

    await executeAgentTool('edit_file', JSON.stringify({ path: 'cache.txt', old_text: 'two', new_text: 'TWO' }), cachedContext);
    const third = JSON.parse(await executeAgentTool('read_file', args, cachedContext));
    expect(third.fromCache).toBe(false);
    expect(third.lines[1].text).toBe('TWO');
  });

  it('writes and edits inside the workspace without approval', async () => {
    approval = false;
    await executeAgentTool('write_file', JSON.stringify({ path: 'new/file.ts', content: 'before' }), context);
    await executeAgentTool('edit_file', JSON.stringify({ path: 'new/file.ts', old_text: 'before', new_text: 'after' }), context);
    await executeAgentTool('multi_edit', JSON.stringify({ path: 'new/file.ts', edits: [{ old_text: 'after', new_text: 'changed' }] }), context);
    expect(await fs.readFile(path.join(workspaceRoot, 'new', 'file.ts'), 'utf8')).toBe('changed');
    expect(approvalRequests).toHaveLength(0);
  });

  it('returns structured mutation results and rejects incomplete arguments', async () => {
    const created = JSON.parse(await executeAgentTool('write_file', JSON.stringify({ path: 'structured.txt', content: 'one\ntwo\n' }), context));
    expect(created).toMatchObject({ success: true, operation: 'create', changed: true, verified: true });
    expect(created.diff).toBe('');

    const replaced = JSON.parse(await executeAgentTool('write_file', JSON.stringify({ path: 'structured.txt', content: 'one\ntwo\nthree\n' }), context));
    expect(replaced).toMatchObject({ success: true, operation: 'replace', changed: true, verified: true });
    expect(replaced.diff).toContain('+three');

    const unchanged = JSON.parse(await executeAgentTool('write_file', JSON.stringify({ path: 'structured.txt', content: 'one\ntwo\nthree\n' }), context));
    expect(unchanged).toMatchObject({ success: true, operation: 'unchanged', changed: false, verified: true });

    const edited = JSON.parse(await executeAgentTool('edit_file', JSON.stringify({ path: 'structured.txt', old_text: 'two', new_text: 'TWO' }), context));
    expect(edited).toMatchObject({ success: true, operation: 'edit', changed: true, editsApplied: 1, verified: true });
    expect(edited.diff).toContain('+TWO');

    expect((await toolError(executeAgentTool('write_file', JSON.stringify({ path: 'missing.txt' }), context))).code).toBe('invalid_arguments');
    expect((await toolError(executeAgentTool('edit_file', JSON.stringify({ old_text: 'x', new_text: 'y' }), context))).code).toBe('invalid_arguments');
  });

  it('accepts line arrays for file content and reports the received type on bad arguments', async () => {
    const created = JSON.parse(await executeAgentTool('write_file', JSON.stringify({
      path: 'lines.txt',
      content: ['one', 'two'],
    }), context));
    expect(created).toMatchObject({ success: true, operation: 'create' });
    expect(await fs.readFile(path.join(workspaceRoot, 'lines.txt'), 'utf8')).toBe('one\ntwo');

    const bad = await toolError(executeAgentTool('write_file', JSON.stringify({
      path: 'bad.txt',
      content: { text: 'nope' },
    }), context));
    expect(bad.code).toBe('invalid_arguments');
    expect(bad.message).toContain('received object');
    expect(bad.details.received).toBe('object');
    expect(bad.hint).toContain('single string');
  });

  it('replaces the whole task plan instead of merging stale steps', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const trackedContext = { ...context, tracker };
    tracker.setSteps([
      { id: 'old-1', title: 'Stale step', status: 'pending' },
      { id: 'old-2', title: 'Another stale step', status: 'pending' },
    ]);

    const saved = JSON.parse(await executeAgentTool('update_task_plan', JSON.stringify({
      steps: [
        { id: 'new-1', title: 'Inspect the page', status: 'in-progress' },
        { id: 'new-2', title: 'Replace the body', status: 'pending' },
      ],
    }), trackedContext));

    expect(saved.replaced).toBe(true);
    expect(tracker.getSteps().map(step => step.id)).toEqual(['new-1', 'new-2']);
    expect(todos.map(todo => todo.title)).toEqual(['Inspect the page', 'Replace the body']);
  });

  it('reports missing and ambiguous edit targets with actionable codes', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'ambiguous.txt'), 'same\nsame\n', 'utf8');
    const ambiguous = await toolError(executeAgentTool('edit_file', JSON.stringify({ path: 'ambiguous.txt', old_text: 'same', new_text: 'different' }), context));
    expect(ambiguous.code).toBe('ambiguous_match');
    expect(ambiguous.details.occurrences).toBe(2);
    expect(ambiguous.details.lines).toEqual([1, 2]);

    const missing = await toolError(executeAgentTool('edit_file', JSON.stringify({ path: 'ambiguous.txt', old_text: 'absent', new_text: 'x' }), context));
    expect(missing.code).toBe('text_not_found');
    expect(missing.hint).toContain('read_file');

    const noop = JSON.parse(await executeAgentTool('edit_file', JSON.stringify({ path: 'ambiguous.txt', old_text: 'same\nsame', new_text: 'same\nsame' }), context));
    expect(noop).toMatchObject({ success: true, changed: false, editsApplied: 0 });
    expect(await fs.readFile(path.join(workspaceRoot, 'ambiguous.txt'), 'utf8')).toBe('same\nsame\n');
  });

  it('preserves CRLF line endings when editing with LF text', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n', 'utf8');
    const result = JSON.parse(await executeAgentTool('edit_file', JSON.stringify({
      path: 'crlf.txt',
      old_text: 'two\nthree',
      new_text: 'TWO\nTHREE',
    }), context));
    expect(result).toMatchObject({ success: true, changed: true, verified: true });
    expect(await fs.readFile(path.join(workspaceRoot, 'crlf.txt'), 'utf8')).toBe('one\r\nTWO\r\nTHREE\r\n');
  });

  it('rolls back multi-edit failures and rejects overlapping edits', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'multi.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    const failed = await toolError(executeAgentTool('multi_edit', JSON.stringify({
      path: 'multi.txt',
      edits: [
        { old_text: 'alpha', new_text: 'A' },
        { old_text: 'missing', new_text: 'M' },
      ],
    }), context));
    expect(failed.code).toBe('text_not_found');
    expect(failed.details.editIndex).toBe(1);
    expect(await fs.readFile(path.join(workspaceRoot, 'multi.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');

    const overlap = await toolError(executeAgentTool('multi_edit', JSON.stringify({
      path: 'multi.txt',
      edits: [
        { old_text: 'alpha\nbeta', new_text: 'x' },
        { old_text: 'beta', new_text: 'y' },
      ],
    }), context));
    expect(overlap.code).toBe('overlapping_edits');
    expect(await fs.readFile(path.join(workspaceRoot, 'multi.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');

    const applied = JSON.parse(await executeAgentTool('multi_edit', JSON.stringify({
      path: 'multi.txt',
      edits: [
        { old_text: 'alpha', new_text: 'beta' },
        { old_text: 'beta', new_text: 'gamma' },
      ],
    }), context));
    expect(applied).toMatchObject({ success: true, changed: true, editsApplied: 2, verified: true });
    expect(await fs.readFile(path.join(workspaceRoot, 'multi.txt'), 'utf8')).toBe('beta\ngamma\ngamma\n');
  });

  it('validates every target before applying coordinated multi-file edits', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'one.ts'), 'export const one = 1;\n', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'two.ts'), 'export const two = 2;\n', 'utf8');
    const tracker = new TaskTracker(workspaceRoot);
    const trackedContext = { ...context, tracker };
    const read = JSON.parse(await executeAgentTool('read_many', JSON.stringify({
      files: [{ path: 'one.ts' }, { path: 'two.ts' }],
    }), trackedContext));

    const result = JSON.parse(await executeAgentTool('multi_file_edit', JSON.stringify({
      files: [
        { path: 'one.ts', expected_hash: read.files[0].hash, edits: [{ old_text: 'one = 1', new_text: 'one = 10' }] },
        { path: 'two.ts', expected_hash: read.files[1].hash, edits: [{ old_text: 'two = 2', new_text: 'two = 20' }] },
      ],
    }), trackedContext));
    expect(result).toMatchObject({ success: true, operation: 'multi_file_edit', changed: true });
    expect(result.files.map((file: { path: string }) => file.path)).toEqual(['one.ts', 'two.ts']);
    expect(await fs.readFile(path.join(workspaceRoot, 'one.ts'), 'utf8')).toContain('one = 10');
    expect(await fs.readFile(path.join(workspaceRoot, 'two.ts'), 'utf8')).toContain('two = 20');
    expect(tracker.getChangedFiles().sort()).toEqual(['one.ts', 'two.ts']);
  });

  it('leaves every file untouched when any multi-file edit fails validation', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'first.ts'), 'const first = 1;\n', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'second.ts'), 'const second = 2;\n', 'utf8');
    const error = await toolError(executeAgentTool('multi_file_edit', JSON.stringify({
      files: [
        { path: 'first.ts', edits: [{ old_text: 'first = 1', new_text: 'first = 10' }] },
        { path: 'second.ts', edits: [{ old_text: 'does not exist', new_text: 'second = 20' }] },
      ],
    }), context));
    expect(error.code).toBe('text_not_found');
    expect(await fs.readFile(path.join(workspaceRoot, 'first.ts'), 'utf8')).toBe('const first = 1;\n');
    expect(await fs.readFile(path.join(workspaceRoot, 'second.ts'), 'utf8')).toBe('const second = 2;\n');
  });

  it('rolls back earlier writes when a later multi-file write hook fails', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'first.ts'), 'const first = 1;\n', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'second.ts'), 'const second = 2;\n', 'utf8');
    let hooks = 0;
    const failingContext = {
      ...context,
      beforeChange: async () => {
        hooks += 1;
        if (hooks === 2) throw new Error('injected checkpoint failure');
      },
    };
    const error = await toolError(executeAgentTool('multi_file_edit', JSON.stringify({
      files: [
        { path: 'first.ts', edits: [{ old_text: 'first = 1', new_text: 'first = 10' }] },
        { path: 'second.ts', edits: [{ old_text: 'second = 2', new_text: 'second = 20' }] },
      ],
    }), failingContext));
    expect(error.message).toContain('injected checkpoint failure');
    expect(await fs.readFile(path.join(workspaceRoot, 'first.ts'), 'utf8')).toBe('const first = 1;\n');
    expect(await fs.readFile(path.join(workspaceRoot, 'second.ts'), 'utf8')).toBe('const second = 2;\n');
  });

  it('detects stale files using the read ledger and expected hashes', async () => {
    const ledger = new ReadLedger();
    const ledgerContext = { ...context, readLedger: ledger };
    const filePath = path.join(workspaceRoot, 'stale.txt');
    await fs.writeFile(filePath, 'original\ntext\n', 'utf8');
    const read = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'stale.txt' }), ledgerContext));
    expect(read.hash).toBeString();

    await fs.writeFile(filePath, 'external\ntext\n', 'utf8');
    await fs.utimes(filePath, new Date(read.mtimeMs), new Date(read.mtimeMs));
    const stale = await toolError(executeAgentTool('edit_file', JSON.stringify({ path: 'stale.txt', old_text: 'original', new_text: 'changed' }), ledgerContext));
    expect(stale.code).toBe('stale_file');
    expect(await fs.readFile(filePath, 'utf8')).toBe('external\ntext\n');

    await fs.writeFile(filePath, 'fresh\ntext\n', 'utf8');
    const fresh = JSON.parse(await executeAgentTool('read_file', JSON.stringify({ path: 'stale.txt' }), context));
    await fs.writeFile(filePath, 'changed\ntext\n', 'utf8');
    const hashStale = await toolError(executeAgentTool('edit_file', JSON.stringify({
      path: 'stale.txt',
      old_text: 'changed',
      new_text: 'final',
      expected_hash: fresh.hash,
    }), context));
    expect(hashStale.code).toBe('stale_file');
    expect(await fs.readFile(filePath, 'utf8')).toBe('changed\ntext\n');
  });

  it('does not overwrite a file changed while approval is pending', async () => {
    const outsidePath = path.join(workspaceRoot, '..', 'dash-agent-race.txt');
    await fs.writeFile(outsidePath, 'before', 'utf8');
    try {
      const racingContext = {
        ...context,
        approve: async () => {
          await fs.writeFile(outsidePath, 'user-change', 'utf8');
          return true;
        },
      };
      const error = await toolError(executeAgentTool('edit_file', JSON.stringify({
        path: '../dash-agent-race.txt',
        old_text: 'before',
        new_text: 'after',
      }), racingContext));
      expect(error.code).toBe('stale_file');
      expect(await fs.readFile(outsidePath, 'utf8')).toBe('user-change');
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('rejects directory write targets and cancelled edits without changing files', async () => {
    const filePath = path.join(workspaceRoot, 'cancel.txt');
    await fs.writeFile(filePath, 'original', 'utf8');
    await fs.mkdir(path.join(workspaceRoot, 'directory-target'));
    const directory = await toolError(executeAgentTool('write_file', JSON.stringify({
      path: 'directory-target',
      content: 'nope',
    }), context));
    expect(directory.code).toBe('not_a_file');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await toolError(executeAgentTool('edit_file', JSON.stringify({
      path: 'cancel.txt',
      old_text: 'original',
      new_text: 'changed',
    }), { ...context, signal: controller.signal }));
    expect(cancelled.code).toBe('cancelled');
    expect(await fs.readFile(filePath, 'utf8')).toBe('original');
  });

  it('requires approval for writes and edits outside the workspace', async () => {
    const outsidePath = path.join(workspaceRoot, '..', 'dash-agent-outside.txt');
    try {
      approval = false;
      const denied = JSON.parse(await executeAgentTool('write_file', JSON.stringify({ path: '../dash-agent-outside.txt', content: 'blocked' }), context));
      expect(denied).toMatchObject({ success: false, errorCode: 'approval_denied', changed: false });
      expect(denied.message).toContain('denied');
      expect(approvalRequests[0]).toContain('write_file');
      expect(approvalRequests[0]).toContain('OUTSIDE');
      expect(await fs.stat(outsidePath).catch(() => null)).toBeNull();

      approval = true;
      await executeAgentTool('write_file', JSON.stringify({ path: '../dash-agent-outside.txt', content: 'before' }), context);
      expect(await fs.readFile(outsidePath, 'utf8')).toBe('before');

      approval = false;
      expect(await executeAgentTool('edit_file', JSON.stringify({ path: '../dash-agent-outside.txt', old_text: 'before', new_text: 'after' }), context)).toContain('denied');
      expect(await fs.readFile(outsidePath, 'utf8')).toBe('before');
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('blocks paths outside the workspace and exposes clarification/checklist tools', async () => {
    await expect(executeAgentTool('read_file', JSON.stringify({ path: '../outside.txt' }), context)).rejects.toThrow('inside the current workspace');

    const answer = await executeAgentTool('ask_user', JSON.stringify({ question: 'Choose one', options: ['first', 'second'] }), context);
    expect(answer).toBe('Choose one: first');

    const activity = JSON.parse(await executeAgentTool('read_session_activity', JSON.stringify({ limit: 4 }), context));
    expect(activity).toEqual({ sessionId: 'current', limit: 4 });

    await executeAgentTool('todo_write', JSON.stringify({ todos: [{ id: 1, title: 'Inspect', status: 'completed' }] }), context);
    expect(todos[0]?.status).toBe('completed');
  });

  it('requires approval before running shell commands', async () => {
    approval = false;
    expect(await executeAgentTool('run_command', JSON.stringify({ command: 'echo should-not-run' }), context)).toContain('denied');
    expect(approvalRequests[0]).toContain('run_command');

    approval = true;
    const result = JSON.parse(await executeAgentTool('run_command', JSON.stringify({ command: 'echo approval-test' }), context));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('approval-test');
  });

  it('requires approval before replacing persistent agent memory', async () => {
    approval = false;
    const result = await executeAgentTool('write_memory', JSON.stringify({ content: 'Do not persist this test.' }), context);
    expect(result).toContain('denied');
    expect(approvalRequests[0]).toContain('write_memory');
  });

  it('returns bounded capability and recovery knowledge', async () => {
    const capability = JSON.parse(await executeAgentTool('get_agent_knowledge', JSON.stringify({ query: 'edit_file', limit: 2 }), context));
    expect(capability.source).toBe('tool-schema');
    expect(capability.capabilities[0].name).toBe('edit_file');
    expect(capability.capabilities[0].recovery.some((entry: { code: string }) => entry.code === 'stale_file')).toBe(true);

    const recovery = JSON.parse(await executeAgentTool('get_agent_knowledge', JSON.stringify({ query: 'stale_file' }), context));
    expect(recovery.errorRecovery.recovery).toContain('Re-read');
    expect(recovery.capabilities.length).toBeGreaterThan(0);

    await expect(executeAgentTool('get_agent_knowledge', JSON.stringify({}), context)).rejects.toThrow('query');
  });

  it('includes source-attributed project knowledge in the project map', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'tool-demo', scripts: { test: 'bun test' }, devDependencies: { typescript: '^5.0.0' } }), 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'bun.lock'), '', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# Tool demo\n\nA demo workspace for knowledge retrieval.\n', 'utf8');
    const map = JSON.parse(await executeAgentTool('get_project_map', JSON.stringify({}), context));
    expect(map.ecosystem).toBe('bun');
    expect(map.knowledge.purpose).toContain('demo workspace');
    expect(map.knowledge.freshness.indexStale).toBe(false);
    expect(map.knowledge.sources.some((source: { path: string }) => source.path === 'workspace-index')).toBe(true);
    expect(map.knowledge.documents.some((document: { path: string }) => document.path === 'README.md')).toBe(true);
  });
});

describe('structured search and patch tools', () => {
  beforeEach(async () => {
    await fs.writeFile(
      path.join(workspaceRoot, 'src', 'layers', 'notes.ts'),
      '// Greeting helpers\nexport function greeting(name: string) {\n  return `hello ${name}`;\n}\n',
      'utf8',
    );
    await fs.writeFile(path.join(workspaceRoot, 'src', 'legacy.js'), 'const greeting = "legacy";\n', 'utf8');
    await fs.mkdir(path.join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'node_modules', 'pkg', 'hidden.ts'), 'const greeting = "hidden";\n', 'utf8');
  });

  it('searches contents with regex, filters, scope, context, and limits', async () => {
    const literal = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'greeting' }), context));
    expect(literal.success).toBe(true);
    expect(literal.count).toBeGreaterThan(0);
    expect(literal.matches.some((match: { path: string }) => match.path === 'src/layers/notes.ts')).toBe(true);
    expect(literal.matches.every((match: { path: string }) => !match.path.includes('node_modules'))).toBe(true);

    const regex = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'greet\\w+', regex: true }), context));
    expect(regex.matches.some((match: { path: string }) => match.path === 'src/layers/notes.ts')).toBe(true);

    const caseInsensitive = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'GREETING HELPERS' }), context));
    expect(caseInsensitive.count).toBeGreaterThan(0);

    const caseSensitive = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'GREETING HELPERS', case_sensitive: true }), context));
    expect(caseSensitive.count).toBe(0);

    const typescriptOnly = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'greeting', extensions: ['ts'] }), context));
    expect(typescriptOnly.matches.every((match: { path: string }) => match.path.endsWith('.ts'))).toBe(true);
    expect(typescriptOnly.matches.some((match: { path: string }) => match.path.endsWith('legacy.js'))).toBe(false);

    const scoped = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'greeting', path: 'src/layers/notes.ts' }), context));
    expect(scoped.matches).toHaveLength(2);
    expect(scoped.matches.every((match: { path: string }) => match.path === 'src/layers/notes.ts')).toBe(true);

    const withContext = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'return `hello', path: 'src/layers/notes.ts', context_lines: 1 }), context));
    expect(withContext.matches[0].before.length).toBe(1);
    expect(withContext.matches[0].after.length).toBe(1);

    const limited = JSON.parse(await executeAgentTool('grep', JSON.stringify({ query: 'greeting', limit: 1 }), context));
    expect(limited.matches).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });

  it('finds files by glob with directory scope and limits', async () => {
    const all = JSON.parse(await executeAgentTool('glob', JSON.stringify({ pattern: '**/*.ts' }), context));
    expect(all.files).toContain('src/layers/sample.ts');
    expect(all.files).toContain('src/layers/notes.ts');

    const scoped = JSON.parse(await executeAgentTool('glob', JSON.stringify({ pattern: '*.js', path: 'src' }), context));
    expect(scoped.files).toEqual(['src/legacy.js']);

    const page = JSON.parse(await executeAgentTool('glob', JSON.stringify({ pattern: '**/*', limit: 1 }), context));
    expect(page.files).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.nextOffset).toBe(1);
  });

  it('applies unified diffs and validates before writing', async () => {
    const patch = [
      '--- a/src/layers/sample.ts',
      '+++ b/src/layers/sample.ts',
      '@@ -1,1 +1,1 @@',
      '-const greeting = "hello";',
      '+const greeting = "hi";',
      '',
    ].join('\n');
    const dryRun = JSON.parse(await executeAgentTool('apply_patch', JSON.stringify({ patch, dry_run: true }), context));
    expect(dryRun.success).toBe(true);
    expect(dryRun.dryRun).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, 'src', 'layers', 'sample.ts'), 'utf8')).toContain('hello');

    const applied = JSON.parse(await executeAgentTool('apply_patch', JSON.stringify({ patch }), context));
    expect(applied.success).toBe(true);
    expect(applied.files[0].changed).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, 'src', 'layers', 'sample.ts'), 'utf8')).toContain('hi');

    const mismatch = await toolError(executeAgentTool('apply_patch', JSON.stringify({
      patch: [
        '*** Begin Patch',
        '*** Update File: src/layers/sample.ts',
        '@@',
        '-not present',
        '+replacement',
        '*** End Patch',
      ].join('\n'),
    }), context));
    expect(mismatch.code).toBe('text_not_found');
    expect(mismatch.hint).toContain('Re-read');

    const malformed = await toolError(executeAgentTool('apply_patch', JSON.stringify({ patch: 'not a patch' }), context));
    expect(malformed.code).toBe('invalid_arguments');
    expect(malformed.hint).toContain('file headers');
    expect(malformed.hint).toContain('edit_file');
  });

  it('rolls back earlier files if a later patch target fails', async () => {
    const samplePath = path.join(workspaceRoot, 'src', 'layers', 'sample.ts');
    const notesPath = path.join(workspaceRoot, 'src', 'layers', 'notes.ts');
    const originalSample = await fs.readFile(samplePath, 'utf8');
    const originalNotes = await fs.readFile(notesPath, 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/layers/sample.ts',
      '@@',
      '-const greeting = "hello";',
      '+const greeting = "patched";',
      '*** Update File: src/layers/notes.ts',
      '@@',
      '-// Greeting helpers',
      '+// Updated helpers',
      '*** End Patch',
    ].join('\n');
    let hooks = 0;
    const failingContext = {
      ...context,
      beforeChange: async () => {
        hooks += 1;
        if (hooks === 2) throw new Error('simulated second-file failure');
      },
    };
    const error = await toolError(executeAgentTool('apply_patch', JSON.stringify({ patch }), failingContext));
    expect(error.code).toBe('tool_failed');
    expect(await fs.readFile(samplePath, 'utf8')).toBe(originalSample);
    expect(await fs.readFile(notesPath, 'utf8')).toBe(originalNotes);
  });

  it('adds and deletes files through apply_patch', async () => {
    const addPatch = [
      '*** Begin Patch',
      '*** Add File: docs/guide.md',
      '+# Guide',
      '+Content here.',
      '*** End Patch',
    ].join('\n');
    const added = JSON.parse(await executeAgentTool('apply_patch', JSON.stringify({ patch: addPatch }), context));
    expect(added.files[0].kind).toBe('add');
    expect(await fs.readFile(path.join(workspaceRoot, 'docs', 'guide.md'), 'utf8')).toBe('# Guide\nContent here.\n');

    const duplicate = await toolError(executeAgentTool('apply_patch', JSON.stringify({ patch: addPatch }), context));
    expect(duplicate.code).toBe('invalid_arguments');

    const deletePatch = [
      '*** Begin Patch',
      '*** Delete File: docs/guide.md',
      '*** End Patch',
    ].join('\n');
    const deleted = JSON.parse(await executeAgentTool('apply_patch', JSON.stringify({ patch: deletePatch }), context));
    expect(deleted.files[0].kind).toBe('delete');
    await expect(fs.stat(path.join(workspaceRoot, 'docs', 'guide.md'))).rejects.toThrow();
  });

  it('creates nested directories and asks before leaving the workspace', async () => {
    const created = JSON.parse(await executeAgentTool('create_directory', JSON.stringify({ path: 'src/generated/assets' }), context));
    expect(created.success).toBe(true);
    expect((await fs.stat(path.join(workspaceRoot, 'src', 'generated', 'assets'))).isDirectory()).toBe(true);

    approval = false;
    const denied = JSON.parse(await executeAgentTool('create_directory', JSON.stringify({ path: '../dash-outside-directory' }), context));
    expect(denied.success).toBe(false);
    expect(denied.errorCode).toBe('approval_denied');
    expect(approvalRequests.at(-1)).toContain('create_directory');
  });

  it('loads project skill instructions on demand and rejects unknown skills', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.dash', 'skills', 'deploy'), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, '.dash', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy safely.\n---\n\nRun the deployment checklist.\n',
      'utf8',
    );
    const skill = JSON.parse(await executeAgentTool('skill_loader', JSON.stringify({ name: 'deploy' }), context));
    expect(skill.success).toBe(true);
    expect(skill.name).toBe('deploy');
    expect(skill.instructions).toContain('Run the deployment checklist.');
    expect(skill.note).toContain('untrusted');

    const missing = await toolError(executeAgentTool('skill_loader', JSON.stringify({ name: 'missing' }), context));
    expect(missing.code).toBe('file_not_found');

    const traversal = await toolError(executeAgentTool('skill_loader', JSON.stringify({ name: '../deploy' }), context));
    expect(traversal.code).toBe('file_not_found');
  });
});
