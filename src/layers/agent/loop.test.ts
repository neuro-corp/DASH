import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_AGENT_PROMPT_TOKENS } from '../../context-window';
import { compactConversationWithTelemetry, isContextCompactionSummary, runAgentLoop, type ChatTurnResult, type ContextCompactionInfo, type VerifyFunction } from './loop';
import { agentTools, executeAgentTool, type ToolContext, type AgentTodo } from './tools';
import { TaskTracker, taskStatePath } from './taskstate';
import type { NvidiaToolCall } from '../../providers/nvidia';

let workspaceRoot: string;
let dataDir: string;
let previousDataDir: string | undefined;
let todos: AgentTodo[] = [];

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: workspaceRoot,
    approve: async () => true,
    ask: async question => `${question}: answered`,
    readSessionActivity: () => '{}',
    updateTodos: value => { todos = value; },
    ...overrides,
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): NvidiaToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function script(functions: Array<(turn: number) => ChatTurnResult>): (messages: unknown[]) => Promise<ChatTurnResult> {
  let turn = 0;
  return async () => {
    const response = functions[Math.min(turn, functions.length - 1)]?.(turn) ?? { content: 'done', toolCalls: [] };
    turn++;
    return response;
  };
}

beforeEach(async () => {
  previousDataDir = process.env.DASH_DATA_DIR;
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-agent-loop-'));
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-agent-loop-data-'));
  process.env.DASH_DATA_DIR = dataDir;
  todos = [];
});

afterEach(async () => {
  await fs.rm(taskStatePath(workspaceRoot), { force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DASH_DATA_DIR;
  else process.env.DASH_DATA_DIR = previousDataDir;
});

describe('agent loop', () => {
  it('runs multiple consecutive tool-calling turns and returns results to context', async () => {
    const seenMessages: unknown[] = [];
    const chat = async (messages: any[]) => {
      seenMessages.push(messages);
      if (messages.filter(m => m.role === 'tool').length < 2) {
        return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'src/a.ts', content: 'a' })] };
      }
      return { content: 'All steps completed and verified.', toolCalls: [] };
    };
    const tracker = new TaskTracker(workspaceRoot);
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Write two files',
      chat: chat as any,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(result.turns).toBe(3);
    expect(result.toolsUsed).toBe(2);
    const secondCall = seenMessages[1] as { role: string; tool_call_id: string }[];
    expect(secondCall.some(m => m.role === 'tool')).toBe(true);
    expect(tracker.getChangedFiles()).toEqual(['src/a.ts']);
  });

  it('injects compact project knowledge and records completed operations', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'loop-demo', scripts: { test: 'bun test' } }), 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'bun.lock'), '', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# Loop demo\n\nA demo project used to verify runtime knowledge injection.\n', 'utf8');
    const seenMessages: any[][] = [];
    const chat = async (messages: any[]) => {
      seenMessages.push(messages);
      if (messages.filter(m => m.role === 'tool').length === 0) {
        return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'src/runtime.ts', content: 'runtime' })] };
      }
      return { content: 'Completed.', toolCalls: [] };
    };
    const tracker = new TaskTracker(workspaceRoot);
    await runAgentLoop({
      workspaceRoot,
      objective: 'Write runtime source',
      chat: chat as any,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    const runtimeContext = String(seenMessages[0]?.find(message => String(message.content).startsWith('<runtime_context>'))?.content ?? '');
    expect(runtimeContext).toContain('Project knowledge');
    expect(runtimeContext).toContain('runtime knowledge injection');
    expect(runtimeContext).toContain('Task-state snapshot');
    expect(runtimeContext).not.toContain('Detected project');
    expect(tracker.getHistory(5).some(entry => entry.label.includes('Completed write_file') && entry.label.includes('src/runtime.ts'))).toBe(true);
    expect(tracker.getHistory(5).every(entry => entry.detail === undefined || entry.detail.length <= 400)).toBe(true);
  });

  it('executes multiple tool calls in one response and feeds every result back', async () => {
    const chat = script([
      () => ({
        content: '',
        toolCalls: [toolCall('t1', 'write_file', { path: 'a.ts', content: 'A' }), toolCall('t2', 'write_file', { path: 'b.ts', content: 'B' })],
      }),
      () => ({ content: 'wrote both files', toolCalls: [] }),
    ]);
    const tracker = new TaskTracker(workspaceRoot);
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Write two files in one turn',
      chat: chat as any,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(tracker.getChangedFiles().sort()).toEqual(['a.ts', 'b.ts']);
    expect((await fs.readFile(path.join(workspaceRoot, 'a.ts'), 'utf8'))).toBe('A');
    expect((await fs.readFile(path.join(workspaceRoot, 'b.ts'), 'utf8'))).toBe('B');
  });

  it('does not execute a tool that was not exposed to the current task', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const toolResults: string[] = [];
    let executions = 0;
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Read this file only',
      chat: async () => {
        calls += 1;
        if (calls === 1) return {
          content: '',
          toolCalls: [toolCall('unexpected-write', 'write_file', { path: 'blocked.txt', content: 'must not be written' })],
        };
        return { content: 'The write tool was unavailable, so no file was created.', toolCalls: [] };
      },
      tools: [],
      allowedToolNames: ['read_file'],
      executeTool: async (...args) => {
        executions += 1;
        return executeAgentTool(...args);
      },
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      callbacks: { onToolResult: (_call, output) => toolResults.push(output) },
    });

    expect(result.phase).toBe('completed');
    expect(executions).toBe(0);
    expect(JSON.parse(toolResults[0] ?? '{}')).toMatchObject({
      success: false,
      errorCode: 'tool_not_available',
    });
    expect(await fs.stat(path.join(workspaceRoot, 'blocked.txt')).catch(() => null)).toBeNull();
  });

  it('preserves successful structured MCP results and reports structured MCP errors as failures', async () => {
    const cases = [
      {
        output: JSON.stringify({ success: true, server: 'producthunt', tool: 'search', content: [{ type: 'text', text: 'launches found' }] }),
        failed: false,
      },
      {
        output: JSON.stringify({ success: false, error: 'Product Hunt authorization required.' }),
        failed: true,
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const observed: Array<{ output: string; failed: boolean }> = [];
      let turns = 0;
      const toolName = 'mcp_producthunt_search';
      const result = await runAgentLoop({
        workspaceRoot,
        objective: 'Use the Product Hunt MCP search tool',
        chat: async () => {
          turns++;
          return turns === 1
            ? { content: '', toolCalls: [toolCall(`mcp-${index}`, toolName, { query: 'AI' })] }
            : { content: 'Finished.', toolCalls: [] };
        },
        tools: [],
        allowedToolNames: [toolName],
        executeTool: async () => testCase.output,
        toolContext: makeContext(),
        tracker: new TaskTracker(workspaceRoot),
        autoVerifyKinds: [],
        callbacks: { onToolResult: (_call, output, failed) => observed.push({ output, failed }) },
      });
      expect(result.phase).toBe('completed');
      expect(observed).toEqual([{ output: testCase.output, failed: testCase.failed }]);
      const toolMessage = result.conversation.find(message => message.role === 'tool');
      expect(toolMessage?.content).toBe(testCase.output);
    }
  });

  it('routes execute_command through enabled run_command with normal approval', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const dispatched: string[] = [];
    const outputs: string[] = [];
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Run a short command',
      chat: async () => {
        calls += 1;
        return calls === 1
          ? { content: '', toolCalls: [toolCall('alias', 'execute_command', { command: 'echo alias-test' })] }
          : { content: 'Command ran.', toolCalls: [] };
      },
      tools: agentTools,
      allowedToolNames: ['run_command'],
      executeTool: async (name, args, context) => {
        dispatched.push(name);
        return executeAgentTool(name, args, context);
      },
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      callbacks: { onToolResult: (_call, output) => outputs.push(output) },
    });

    expect(result.phase).toBe('completed');
    expect(dispatched).toEqual(['run_command']);
    expect(JSON.parse(outputs[0] ?? '{}').output).toContain('alias-test');
  });

  it('treats a completion claim without verification as incomplete and runs verification', async () => {
    let chatIndex = 0;
    const chatFn = async () => {
      const index = chatIndex++;
      if (index === 0) return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'src/y.ts', content: 'y=1;' })] };
      if (index === 1) return { content: 'I have finished the task.', toolCalls: [] };
      return { content: 'Verification complete, ending now.', toolCalls: [] };
    };
    const tracker = new TaskTracker(workspaceRoot);
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Verify gating',
      chat: chatFn,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => [{ name: 'syntax', kind: 'syntax', method: 'fake', status: 'pass', summary: 'ok' }],
      autoVerifyKinds: ['syntax'],
      maxTurns: 6,
    });
    expect(result.phase).toBe('completed');
    expect(result.verification.some(r => r.status === 'pass')).toBe(true);
  });

  it('fails verification then repairs and passes on the next round', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let chatIndex = 0;
    const chatFn = async () => {
      const index = chatIndex++;
      if (index === 0) return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'src/x.ts', content: 'x=1;' })] };
      return { content: 'Done.', toolCalls: [] };
    };
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'repair flow',
      chat: chatFn,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => [
        { name: 'tests', kind: 'test', method: 'fake', status: 'fail', failure: 'src/x.ts: 1 failing test' },
      ],
      autoVerifyKinds: ['test'],
      maxTurns: 10,
    });
    // Verification failure is reported, not acted on: the run still ends after
    // the agent's final answer instead of entering a repair loop.
    expect(result.phase).toBe('completed');
    expect(chatIndex).toBe(2);
    expect(result.verification[0]?.status).toBe('fail');
    expect(result.finalMessage).toBe('Done.');
  });

  it('skips project verification when only static assets changed', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let verifyCalls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'replace index.html with hello world',
      chat: script([
        () => ({ content: 'Writing the page.', toolCalls: [toolCall('t1', 'write_file', { path: 'html/index.html', content: '<h1>Hello World</h1>' })] }),
        () => ({ content: 'Done.', toolCalls: [] }),
      ]) as any,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => {
        verifyCalls += 1;
        return [{ name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'fail', failure: 'src/cli.ts(1,1): error TS1005' }];
      },
      maxTurns: 6,
    });
    expect(verifyCalls).toBe(0);
    expect(result.phase).toBe('completed');
    expect(result.verification).toEqual([]);
  });

  it('treats failures in unchanged files as pre-existing instead of repairing them', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let verifyCalls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'change the title',
      chat: script([
        () => ({ content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'src/title.ts', content: 'export const title = "hi";' })] }),
        () => ({ content: 'Done.', toolCalls: [] }),
      ]) as any,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => {
        verifyCalls += 1;
        return [{
          name: 'typecheck',
          kind: 'typecheck',
          method: 'fake',
          status: 'fail',
          failure: 'src/cli.ts(3,1): error TS1005: pre-existing syntax error',
          output: 'src/cli.ts(3,1): error TS1005',
        }];
      },
      autoVerifyKinds: ['typecheck'],
      maxTurns: 6,
    });
    expect(verifyCalls).toBe(1);
    expect(result.phase).toBe('completed');
    expect(result.verification[0]?.preExisting).toBe(true);
  });

  it('ends the run when the same tool call repeats instead of nudging forever', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'loop detection',
      chat: async () => {
        calls += 1;
        return { content: '', toolCalls: [toolCall('t', 'read_file', { path: 'sample.ts' })] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxTurns: 12,
    });
    expect(result.phase).toBe('blocked');
    expect(calls).toBe(3);
    expect(result.finalMessage).toContain('repeated');
  });

  it('continues when the model narrates an action without calling a tool', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const notices: string[] = [];
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Create the main index.html file',
      chat: async () => {
        calls += 1;
        if (calls === 1) return { content: 'Now let me create the main index.html file:', toolCalls: [] };
        if (calls === 2) return {
          content: '',
          toolCalls: [toolCall('write-index', 'write_file', { path: 'index.html', content: '<main>Hello</main>' })],
        };
        return { content: 'Created index.html.', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      callbacks: { onSystemNotice: notice => notices.push(notice) },
    });

    expect(result.phase).toBe('completed');
    expect(calls).toBe(3);
    expect(result.toolsUsed).toBe(1);
    expect(await fs.readFile(path.join(workspaceRoot, 'index.html'), 'utf8')).toBe('<main>Hello</main>');
    expect(notices[0]).toContain('did not call a tool');
  });

  it('detects an unexecuted next action after progress narration in a follow-up', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Continue the previous website work and create the remaining pages',
      chat: async () => {
        calls += 1;
        if (calls === 1) return {
          content: 'Now I have a clear picture of the existing workspace. The CSS and JS framework is already in place, but the pages directory is empty and assets are empty. Let me create all the HTML pages.',
          toolCalls: [],
        };
        if (calls === 2) return {
          content: '',
          toolCalls: [toolCall('write-pages', 'write_file', { path: 'pages/index.html', content: '<main>Home</main>' })],
        };
        return { content: 'Created the home page.', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });

    expect(result.phase).toBe('completed');
    expect(calls).toBe(3);
    expect(result.toolsUsed).toBe(1);
    expect(await fs.readFile(path.join(workspaceRoot, 'pages', 'index.html'), 'utf8')).toBe('<main>Home</main>');
  });

  it('blocks rather than completing after repeated action narration without tool calls', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Create index.html',
      chat: async () => {
        calls += 1;
        return { content: 'Now let me create index.html:', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });

    expect(result.phase).toBe('blocked');
    expect(result.interrupted).toBe(true);
    expect(calls).toBe(3);
    expect(result.finalMessage).toContain('did not execute it');
  });

  it('retries an empty response and continues when the model recovers', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Create a page',
      chat: async () => {
        calls += 1;
        if (calls === 1) return { content: '', toolCalls: [] };
        if (calls === 2) return {
          content: '',
          toolCalls: [toolCall('write-page', 'write_file', { path: 'index.html', content: '<h1>Ready</h1>' })],
        };
        return { content: 'Created index.html.', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });

    expect(result.phase).toBe('completed');
    expect(calls).toBe(3);
    expect(result.finalMessage).toBe('Created index.html.');
    expect(await fs.readFile(path.join(workspaceRoot, 'index.html'), 'utf8')).toBe('<h1>Ready</h1>');
  });

  it('blocks on repeated empty responses without reporting No response or verifying', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    let verifyCalls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Create a page',
      chat: async () => {
        calls += 1;
        if (calls === 1) return {
          content: '',
          toolCalls: [toolCall('write-page', 'write_file', { path: 'index.html', content: '<h1>Ready</h1>' })],
        };
        return { content: '', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => {
        verifyCalls += 1;
        return [];
      },
      autoVerifyKinds: ['test'],
    });

    expect(result.phase).toBe('blocked');
    expect(result.interrupted).toBe(true);
    expect(result.finalMessage).toContain('empty response');
    expect(result.finalMessage).not.toBe('No response');
    expect(verifyCalls).toBe(0);
    expect(calls).toBe(4);
  });

  it('resets repeated-call detection after a different tool action', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const responses = [
      { content: '', toolCalls: [toolCall('t1', 'run_command', { command: 'echo ok' })] },
      { content: '', toolCalls: [toolCall('t2', 'read_file', { path: 'sample.ts' })] },
      { content: '', toolCalls: [toolCall('t3', 'run_command', { command: 'echo ok' })] },
      { content: '', toolCalls: [toolCall('t4', 'read_file', { path: 'sample.ts' })] },
      { content: '', toolCalls: [toolCall('t5', 'run_command', { command: 'echo ok' })] },
      { content: 'Done.', toolCalls: [] },
    ];
    let turn = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'continue after making progress between commands',
      chat: async () => responses[turn++] ?? { content: 'Done.', toolCalls: [] },
      tools: [],
      executeTool: async () => '{"success":true}',
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxTurns: 10,
    });
    expect(result.phase).toBe('completed');
    expect(result.toolsUsed).toBe(5);
  });

  it('treats different key order as the same repeated call', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'similar call detection',
      chat: async () => {
        calls += 1;
        const args = calls % 2 === 0 ? '{"path":"a.ts","limit":5}' : '{"limit":5,"path":"a.ts"}';
        return { content: '', toolCalls: [{ id: `t${calls}`, type: 'function' as const, function: { name: 'read_file', arguments: args } }] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxTurns: 12,
    });
    expect(result.phase).toBe('blocked');
    expect(calls).toBe(3);
  });

  it('stops at the tool-call cap with a message to the user', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'tool cap',
      chat: async () => {
        calls += 1;
        return { content: '', toolCalls: [toolCall(`t${calls}`, 'read_file', { path: `file-${calls}.ts` })] };
      },
      tools: [],
      executeTool: async () => '{"ok":true}',
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxToolCalls: 3,
      maxTurns: 20,
    });
    expect(result.phase).toBe('blocked');
    expect(result.toolsUsed).toBe(3);
    expect(result.finalMessage).toContain('tool calls');
  });

  it('allows more than 40 tool calls by default for large tasks', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let turns = 0;
    let executed = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'Inspect this large workspace',
      chat: async () => {
        turns += 1;
        if (turns === 1) {
          return {
            content: '',
            toolCalls: Array.from({ length: 45 }, (_, index) =>
              toolCall(`read-${index}`, 'read_file', { path: `file-${index}.txt` })),
          };
        }
        return { content: 'Workspace inspection complete.', toolCalls: [] };
      },
      tools: [],
      executeTool: async () => {
        executed += 1;
        return '{"success":true}';
      },
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });

    expect(result.phase).toBe('completed');
    expect(result.toolsUsed).toBe(45);
    expect(executed).toBe(45);
    expect(turns).toBe(2);
  });

  it('closes the whole tool batch and stores the limit notice when the cap is reached mid-batch', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const executed: string[] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'finish the planned task',
      chat: async () => ({
        content: '',
        toolCalls: [
          toolCall('first', 'read_file', { path: 'one.ts' }),
          toolCall('second', 'read_file', { path: 'two.ts' }),
        ],
      }),
      tools: [],
      executeTool: async (_name, args) => {
        executed.push(args);
        return '{"ok":true}';
      },
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxToolCalls: 1,
    });

    const toolResults = result.conversation.filter(message => message.role === 'tool');
    expect(result.phase).toBe('blocked');
    expect(executed).toHaveLength(1);
    expect(toolResults.map(message => message.tool_call_id)).toEqual(['first', 'second']);
    expect(result.conversation.at(-1)?.content).toContain('reached the limit');
  });

  it('reports cancellation immediately when signal aborts during tool execution', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const controller = new AbortController();
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'cancel test',
      signal: controller.signal,
      chat: async () => ({ content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'big.ts', content: 'x'.repeat(10) })] }),
      tools: [],
      executeTool: async (name, args, ctx) => {
        if (name === 'write_file') controller.abort();
        return executeAgentTool(name, args, ctx);
      },
      toolContext: makeContext({ tracker, signal: controller.signal }),
      tracker,
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('cancelled');
    expect(result.turns).toBeGreaterThan(0);
  });

  it('handles malformed tool arguments by reporting a tool error without crashing', async () => {
    let turn = 0;
    const chat = async () => {
      turn++;
      if (turn === 1) return { content: '', toolCalls: [{ id: 't1', type: 'function' as const, function: { name: 'write_file', arguments: '{not json' } }] };
      return { content: 'Recovered from malformed arguments.', toolCalls: [] };
    };
    const tracker = new TaskTracker(workspaceRoot);
    const toolFailures: string[] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'malformed args',
      chat: chat as any,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      callbacks: { onToolResult: (_call, output, failed) => { if (failed) toolFailures.push(output); } },
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(toolFailures.some(output => output.toLowerCase().includes('failed'))).toBe(true);
    const failure = JSON.parse(toolFailures[0] ?? '{}');
    expect(failure).toMatchObject({ success: false, failed: true, errorCode: 'invalid_arguments' });
    expect(failure.hint).toBeString();
  });

  it('blocks an identical failed tool call until arguments or state change', async () => {
    let turn = 0;
    let executed = 0;
    const chat = async () => {
      turn++;
      if (turn <= 2) {
        return {
          content: '',
          toolCalls: [toolCall(`t${turn}`, 'edit_file', { path: 'missing-file.txt', old_text: 'x', new_text: 'y' })],
        };
      }
      return { content: 'Recovered after re-reading.', toolCalls: [] };
    };
    const tracker = new TaskTracker(workspaceRoot);
    const failures: string[] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'repeated failure',
      chat: chat as any,
      tools: [],
      executeTool: async (name, args, ctx) => {
        executed++;
        return executeAgentTool(name, args, ctx);
      },
      toolContext: makeContext({ tracker }),
      tracker,
      callbacks: { onToolResult: (_call, output, failed) => { if (failed) failures.push(output); } },
      autoVerifyKinds: [],
    });
    expect(executed).toBe(1);
    expect(result.phase).toBe('completed');
    const repeated = failures.map(output => JSON.parse(output)).find(payload => payload.errorCode === 'repeated_failure');
    expect(repeated).toMatchObject({ success: false, failed: true, retryable: true });
    expect(repeated.hint).toContain('Re-read');
  });

  it('ends immediately on a final answer even when plan steps are still open', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    tracker.setObjective('pending steps');
    tracker.setSteps([
      { id: 's1', title: 'never done', status: 'pending' },
    ]);
    const systemNotices: string[] = [];
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'pending steps',
      chat: async () => {
        calls += 1;
        return { content: 'I am finished.', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxTurns: 8,
      callbacks: { onSystemNotice: n => systemNotices.push(n) },
    });
    expect(result.phase).toBe('completed');
    expect(systemNotices).toEqual([]);
    expect(calls).toBe(1);
    expect(result.finalMessage).toBe('I am finished.');
  });

  it('accepts the final answer after real work even when plan steps are still open', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    let verifyCalls = 0;
    const systemNotices: string[] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'change the title',
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [
              toolCall('t1', 'write_file', { path: 'src/title.ts', content: 'export const title = "hi";' }),
              toolCall('t2', 'update_task_plan', {
                steps: [
                  { id: 's1', title: 'Edit title', status: 'completed' },
                  { id: 's2', title: 'Polish title', status: 'in-progress' },
                ],
              }),
            ],
          } as any;
        }
        return { content: 'Done. Title updated and verified.', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => {
        verifyCalls += 1;
        return [{ name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'pass' }];
      },
      autoVerifyKinds: ['typecheck'],
      maxTurns: 12,
      callbacks: { onSystemNotice: n => systemNotices.push(n) },
    });
    expect(result.phase).toBe('completed');
    expect(verifyCalls).toBe(1);
    expect(calls).toBe(2);
    expect(systemNotices).toEqual([]);
    expect(result.finalMessage).toBe('Done. Title updated and verified.');
  });

  it('stops after a simple file creation even when unrelated tests are failing', async () => {
    // Reproduction: a Bun/TypeScript workspace. The user asks for a small
    // Python script in html/. The repo's own tests are already failing. The run
    // must end after the model's final answer, with no extra investigation.
    await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'repro', scripts: { test: 'bun test' } }), 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'bun.lock'), '', 'utf8');

    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    let verifyCalls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'in the html folder create a python file and tell me the output',
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [toolCall('t1', 'write_file', { path: 'html/script.py', content: 'print("hi")' })],
          };
        }
        if (calls === 2) return { content: 'Created html/script.py. Output: hi', toolCalls: [] };
        // Any further turn is the bug: the agent would be investigating
        // unrelated pre-existing failures.
        return { content: '', toolCalls: [toolCall(`t${calls}`, 'read_file', { path: 'src/cliArgs.test.ts' })] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => {
        verifyCalls += 1;
        return [{
          name: 'test',
          kind: 'test',
          method: 'fake',
          status: 'fail',
          failure: 'CLI args handling > dash --version prints version and exits without UI',
          output: 'src/cliArgs.test.ts(17,27): failed',
        }];
      },
      autoVerifyKinds: ['syntax', 'typecheck', 'test'],
      maxTurns: 20,
    });

    expect(result.phase).toBe('completed');
    // A .py file is not covered by this project's TypeScript checks.
    expect(verifyCalls).toBe(0);
    expect(calls).toBe(2);
    expect(result.turns).toBe(2);
    expect(result.finalMessage).toContain('Created html/script.py');
  });

  it('already-failing tests in unchanged files are reported, not repaired', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'repro', scripts: { test: 'bun test' } }), 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'bun.lock'), '', 'utf8');
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'change one source file',
      chat: async () => {
        calls += 1;
        if (calls === 1) return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'src/thing.ts', content: 'export const x = 1;' })] };
        return { content: 'Done.', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => [{
        name: 'test',
        kind: 'test',
        method: 'fake',
        status: 'fail',
        failure: 'CLI args handling > dash --version prints version and exits without UI',
        output: 'src/cliArgs.test.ts(17,27): error: expected 0',
      }],
      autoVerifyKinds: ['test'],
      maxTurns: 10,
    });
    expect(result.phase).toBe('completed');
    expect(calls).toBe(2);
    expect(result.verification[0]?.preExisting).toBe(true);
  });

  it('does not re-run auto verification when checks already passed for the same changes', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let verifyCalls = 0;
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'check twice',
      chat: async () => {
        calls += 1;
        if (calls === 1) return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'src/b.ts', content: 'b' })] };
        return { content: 'Done.', toolCalls: [] };
      },
      tools: [],
      executeTool: async (name, args, ctx) => {
        const output = await executeAgentTool(name, args, ctx);
        if (name === 'write_file') {
          // Simulate the model running checks itself via run_checks.
          tracker.setVerification([{ name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'pass' }]);
        }
        return output;
      },
      toolContext: makeContext({ tracker }),
      tracker,
      verify: async () => {
        verifyCalls += 1;
        return [{ name: 'typecheck', kind: 'typecheck', method: 'fake', status: 'pass' }];
      },
      autoVerifyKinds: ['typecheck'],
      maxTurns: 8,
    });
    expect(result.phase).toBe('completed');
    expect(verifyCalls).toBe(0);
    expect(calls).toBe(2);
  });

  it('handles provider errors with retries and keeps going', async () => {
    let calls = 0;
    const tracker = new TaskTracker(workspaceRoot);
    const systemNotices: string[] = [];
    const chat = async () => {
      calls++;
      if (calls === 1) return { content: 'Error: rate limited', toolCalls: [] };
      if (calls === 2) return { content: 'Error: rate limited', toolCalls: [] };
      if (calls === 3) return { content: 'API error 500', toolCalls: [] };
      return { content: 'Recovered and stopping.', toolCalls: [] };
    };
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'provider errors',
      chat: chat as any,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      callbacks: { onSystemNotice: n => systemNotices.push(n) },
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(systemNotices.length).toBeGreaterThanOrEqual(2);
  }, 15000);

  it('surfaces a daily quota limit immediately without retrying', async () => {
    let calls = 0;
    const tracker = new TaskTracker(workspaceRoot);
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'quota reached',
      chat: async () => {
        calls += 1;
        return { content: 'Error: Daily token limit reached (100,000 of 100,000 tokens used).', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });

    expect(calls).toBe(1);
    expect(result.finalMessage).toContain('Daily token limit reached');
  });

  it('accumulates provider-reported token usage across turns', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let chatIndex = 0;
    const usageChat = async () => {
      const index = chatIndex++;
      if (index === 0) return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'a.ts', content: 'A' })], usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
      return { content: 'du', toolCalls: [], usage: { promptTokens: 140, completionTokens: 10, totalTokens: 150 } };
    };
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'usage accumulation',
      chat: usageChat,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(result.tokenUsage).toEqual({ promptTokens: 240, completionTokens: 30, totalTokens: 270 });
  });

  it('records per-request telemetry, cache fields, and cost from provider usage', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const requestEvents: Array<{ request: number; cachedInputTokens: number }> = [];
    let chatIndex = 0;
    const usageChat = async () => {
      const index = chatIndex++;
      if (index === 0) {
        return {
          content: '',
          toolCalls: [toolCall('t1', 'write_file', { path: 'a.ts', content: 'A' })],
          usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedPromptTokens: 600, reasoningTokens: 20 },
        };
      }
      return {
        content: 'done',
        toolCalls: [],
        usage: { promptTokens: 1200, completionTokens: 30, totalTokens: 1260, cachedPromptTokens: 900, reasoningTokens: 10 },
      };
    };
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'telemetry',
      chat: usageChat,
      tools: [{ type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object' } } }],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      pricing: { inputPerMillion: 1, cachedInputPerMillion: 0.5, outputPerMillion: 2, currency: 'USD' },
      callbacks: {
        onRequestTelemetry: telemetry => requestEvents.push({
          request: telemetry.request,
          cachedInputTokens: telemetry.cachedInputTokens,
        }),
      },
    });
    expect(result.phase).toBe('completed');
    expect(result.telemetry.requestCount).toBe(2);
    expect(result.telemetry.usageSource).toBe('provider');
    expect(result.telemetry.cachedInputTokens).toBe(1500);
    expect(result.telemetry.reasoningTokens).toBe(30);
    expect(result.telemetry.requests[0]?.toolCalls).toBe(1);
    expect(result.telemetry.requests[0]?.toolOutputChars).toBeGreaterThan(0);
    expect(result.telemetry.requests[1]?.inputSource).toBe('provider');
    expect(result.telemetry.cost?.total).toBeGreaterThan(0);
    expect(result.telemetry.costSource).toBe('provider-usage');
    expect(result.metrics.actualPromptTokens).toBe(2200);
    expect(requestEvents).toEqual([
      { request: 1, cachedInputTokens: 600 },
      { request: 2, cachedInputTokens: 900 },
    ]);
  });

  it('keeps a stable append-only prompt prefix and removes stale control messages', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const seen: any[][] = [];
    let chatIndex = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'continue prior work',
      chat: async (messages: any[]) => {
        seen.push(messages);
        const index = chatIndex++;
        if (index === 0) return { content: '', toolCalls: [toolCall('t1', 'write_file', { path: 'a.ts', content: 'A' })] };
        return { content: 'done', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      systemMessage: 'STABLE-SYSTEM',
      initialMessages: [
        { role: 'user', content: 'Task: stale task\n\nDetected project: {}' },
        { role: 'user', content: 'Workflow requirements:\nstale workflow' },
        { role: 'user', content: 'continue prior work' },
      ],
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    const first = seen[0] ?? [];
    const second = seen[1] ?? [];
    expect(first.filter(message => message.content === 'continue prior work')).toHaveLength(1);
    expect(first.some(message => String(message.content).startsWith('Task:'))).toBe(false);
    expect(first.some(message => String(message.content).startsWith('Workflow requirements:'))).toBe(false);
    expect(first.some(message => String(message.content).startsWith('<runtime_context>'))).toBe(true);
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
  });

  it('omits only older retrievable tool results when compaction is needed', () => {
    const messages = [
      { role: 'system', content: 'SYSTEM' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'old', type: 'function' as const, function: { name: 'search_files', arguments: '{"query":"a"}' } },
          { id: 'recent', type: 'function' as const, function: { name: 'search_files', arguments: '{"query":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'old', content: JSON.stringify({ matches: ['a'.repeat(400)] }) },
      { role: 'tool', tool_call_id: 'recent', content: JSON.stringify({ matches: ['b'.repeat(400)] }) },
    ];
    const compacted = compactConversationWithTelemetry(messages, {
      maxMessages: 3,
      maxToolOutputChars: 2000,
      maxTokens: 100_000,
      keepRecentToolResults: 1,
      omitOldToolResultChars: 10,
    });
    expect(compacted.omitted).toBe(1);
    const old = compacted.messages.find(message => message.tool_call_id === 'old');
    const recent = compacted.messages.find(message => message.tool_call_id === 'recent');
    expect(JSON.parse(old?.content ?? '{}').omitted).toBe(true);
    expect(JSON.parse(recent?.content ?? '{}').omitted).toBeUndefined();
  });

  it('does not deduplicate equal outputs from different tools', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'read-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"same"}' } },
          { id: 'grep-1', type: 'function' as const, function: { name: 'grep', arguments: '{"path":"same"}' } },
        ],
      },
      { role: 'tool' as const, tool_call_id: 'read-1', content: 'identical output that requires truncation' },
      { role: 'tool' as const, tool_call_id: 'grep-1', content: 'identical output that requires truncation' },
    ];
    const compacted = compactConversationWithTelemetry(messages, {
      maxMessages: 10,
      maxToolOutputChars: 8,
      maxTokens: 10_000,
    });
    expect(compacted.suppressed).toBe(0);
    expect(compacted.messages.filter(message => message.role === 'tool')).toHaveLength(2);
  });

  it('summarizes dropped history when the prompt exceeds the model budget', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const compactions: ContextCompactionInfo[] = [];
    const seen: any[][] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'finish the migration',
      chat: async (messages: any[]) => {
        seen.push(messages);
        return { content: 'done', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxPromptTokens: 1_800,
      initialMessages: Array.from({ length: 12 }, (_, index) => ({
        role: 'user' as const,
        content: `earlier-request-${index} ${'context '.repeat(300)}`,
      })),
      callbacks: {
        onContextCompacted: info => compactions.push(info),
      },
    });

    expect(result.phase).toBe('completed');
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0]?.droppedMessages).toBeGreaterThan(0);
    expect(compactions[0]?.maxPromptTokens).toBe(1_800);

    const prompt = seen[0] ?? [];
    const summary = prompt.find(message =>
      typeof message.content === 'string' && message.content.startsWith('[Context compacted'));
    expect(summary).toBeDefined();
    expect(String(summary?.content)).toContain('Earlier user requests');
    expect(String(summary?.content)).toContain('Re-run a tool');
    expect(result.conversation.some(isContextCompactionSummary)).toBe(true);
    expect(result.conversation.some(message =>
      message.role === 'user' && message.content === 'finish the migration')).toBe(true);
    // The dropped messages are replaced by one summary plus recent context.
    expect(result.conversation.length).toBeLessThan(16);
  });

  it('compacts long conversation history to the default 85% prompt budget', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let sentMessages: any[] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'continue the current task',
      chat: async messages => {
        sentMessages = messages as any[];
        return { content: 'Done.', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      initialMessages: Array.from({ length: 80 }, (_, index) => ({
        role: 'user' as const,
        content: `earlier-context-${index} ${'workspace detail '.repeat(500)}`,
      })),
    });
    const estimatedPromptTokens = Math.ceil(JSON.stringify(sentMessages).length / 4);
    expect(result.phase).toBe('completed');
    expect(estimatedPromptTokens).toBeLessThanOrEqual(DEFAULT_AGENT_PROMPT_TOKENS + 1_000);
    expect(sentMessages.some(message => String(message.content).startsWith('[Context compacted'))).toBe(true);
  });

  it('does not compact while the conversation fits the prompt budget', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const compactions: ContextCompactionInfo[] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'short question',
      chat: async () => ({ content: 'answer', toolCalls: [] }),
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxPromptTokens: 100_000,
      callbacks: {
        onContextCompacted: info => compactions.push(info),
      },
    });
    expect(result.phase).toBe('completed');
    expect(compactions).toHaveLength(0);
    expect(result.conversation.some(isContextCompactionSummary)).toBe(false);
  });


  it('compacts large command output while preserving matching error lines', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const output = Array.from({ length: 400 }, (_, index) =>
      index % 50 === 0 ? `ERROR failed at step ${index}` : `normal log line ${index} `.repeat(4),
    ).join('\n');
    const raw = JSON.stringify({
      exitCode: 1,
      output,
      truncated: false,
      timedOut: false,
      cancelled: false,
      durationMs: 1234,
    });
    let chatIndex = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'run a command',
      chat: async () => {
        const index = chatIndex++;
        if (index === 0) return { content: '', toolCalls: [toolCall('t1', 'run_command', { command: 'test' })] };
        return { content: 'done', toolCalls: [] };
      },
      tools: [],
      executeTool: async () => raw,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxToolOutputChars: 24_000,
    });
    const toolMessage = result.conversation.find(message => message.role === 'tool');
    const parsed = JSON.parse(toolMessage?.content ?? '{}');
    expect(result.phase).toBe('completed');
    expect(parsed.outputCompacted).toBe(true);
    expect(parsed.output).toContain('ERROR failed at step 0');
    expect((toolMessage?.content ?? '').length).toBeLessThan(raw.length);
  });

  it('reports zero token usage when the provider never reports usage', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'no usage',
      chat: async () => ({ content: 'plain reply', toolCalls: [] }),
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(result.tokenUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('carries prior conversation and system context into the provider request', async () => {
    const seenMessages: any[][] = [];
    const tracker = new TaskTracker(workspaceRoot);
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'continue prior work',
      chat: async (messages: any[]) => {
        seenMessages.push(messages);
        return { content: 'finished', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      systemMessage: 'SYSTEM-MARKER',
      initialMessages: [{ role: 'user', content: 'EARLIER-MARKER' }],
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(seenMessages[0]?.some(message => message.role === 'system' && message.content === 'SYSTEM-MARKER')).toBe(true);
    expect(seenMessages[0]?.some(message => message.role === 'user' && message.content === 'EARLIER-MARKER')).toBe(true);
    expect(result.conversation[0]?.content).toBe('SYSTEM-MARKER');
  });

  it('instructs the model to batch file reads and coordinated edits', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let seen: any[] = [];
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'update two configuration files',
      chat: async messages => {
        seen = messages as any[];
        return { content: 'Done.', toolCalls: [] };
      },
      tools: agentTools,
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    const guidance = seen.find(message => String(message.content).startsWith('Batch tool guidance'))?.content ?? '';
    const workflow = seen.find(message => String(message.content).startsWith('Workflow requirements'))?.content ?? '';
    expect(result.phase).toBe('completed');
    expect(workflow).toContain('For a how/where question about changing code');
    expect(workflow).toContain('one targeted search');
    expect(guidance).toContain('read_many');
    expect(guidance).toContain('multi_file_edit');
    expect(guidance).toContain('expected_hash');
  });

  it('does not reread an unchanged range and reports read metrics', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'data.txt'), 'a\nb\nc\n', 'utf8');
    const tracker = new TaskTracker(workspaceRoot);
    let call = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'read metrics',
      chat: async () => {
        call += 1;
        if (call <= 2) return { content: '', toolCalls: [toolCall(`t${call}`, 'read_file', { path: 'data.txt', offset: 1, limit: 2 })] };
        return { content: 'finished', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(result.metrics.filesRead).toBe(1);
    expect(result.metrics.bytesRead).toBeGreaterThan(0);
    expect(result.metrics.estimatedPromptTokens).toBeGreaterThan(0);
  });

  it('suppresses a repeated full-file read while it remains in context', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'small.txt'), 'a\nb\n', 'utf8');
    const tracker = new TaskTracker(workspaceRoot);
    const outputs: string[] = [];
    let call = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'repeat full read',
      chat: async () => {
        call += 1;
        if (call <= 2) return { content: '', toolCalls: [toolCall(`t${call}`, 'read_file', { path: 'small.txt' })] };
        return { content: 'finished', toolCalls: [] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      callbacks: { onToolResult: (_call, output) => outputs.push(output) },
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(result.metrics.filesRead).toBe(1);
    expect(JSON.parse(outputs[1] ?? '{}').unchanged).toBe(true);
  });

  it('respects the iteration budget and produces a final status report', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let counter = 0;
    const budgetChat = async () => {
      counter++;
      return { content: `turn ${counter}`, toolCalls: [toolCall(`t${counter}`, 'list_files', {})] };
    };
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'budget test',
      chat: budgetChat,
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxTurns: 2,
    });
    expect(result.turns).toBeLessThanOrEqual(3);
    expect(['blocked', 'failed', 'cancelled']).toContain(result.phase);
  });
});

describe('bounded final step and parallel execution', () => {
  it('reserves the final permitted iteration for a tool-free summary', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const seenOptions: unknown[] = [];
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'final step behavior',
      chat: async (_messages: any[], _signal: any, options?: unknown) => {
        calls += 1;
        seenOptions.push(options);
        if (calls < 3) {
          return {
            content: '',
            toolCalls: [toolCall(`w${calls}`, 'write_file', { path: `file-${calls}.txt`, content: 'x' })],
          };
        }
        // A provider may still return a tool call; the loop must ignore it.
        return {
          content: 'Final report: two files written, nothing remains.',
          toolCalls: [toolCall('ignored', 'write_file', { path: 'ignored.txt', content: 'x' })],
        };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxTurns: 3,
    });

    expect(calls).toBe(3);
    expect(result.turns).toBe(3);
    expect(result.phase).toBe('blocked');
    expect(result.toolsUsed).toBe(2);
    expect(seenOptions.at(-1)).toEqual({ tools: [] });
    expect(result.finalMessage).toContain('Final report');
    await expect(fs.stat(path.join(workspaceRoot, 'ignored.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(workspaceRoot, 'file-1.txt'), 'utf8')).toBe('x');
    expect(await fs.readFile(path.join(workspaceRoot, 'file-2.txt'), 'utf8')).toBe('x');
  });

  it('produces a deterministic final report when the final response is empty', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let calls = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'empty final response',
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return { content: '', toolCalls: [toolCall('t1', 'list_files', {})] };
        }
        return { content: '   ', toolCalls: [toolCall('ignored', 'list_files', {})] };
      },
      tools: [],
      executeTool: executeAgentTool,
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      maxTurns: 2,
    });
    expect(calls).toBe(2);
    expect(result.finalMessage).toContain('Final status (step limit reached)');
    expect(result.finalMessage).toContain('Incomplete:');
    expect(result.finalMessage).toContain('Remaining work:');
  });

  it('runs independent read-only tools concurrently and keeps call order', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    const seen: any[][] = [];
    const durations: number[] = [];
    let active = 0;
    let maxActive = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'parallel reads',
      chat: async (messages: any[]) => {
        seen.push(messages);
        if (seen.length === 1) {
          return {
            content: '',
            toolCalls: [
              toolCall('r1', 'read_file', { path: 'first.txt' }),
              toolCall('r2', 'read_file', { path: 'second.txt' }),
            ],
          };
        }
        return { content: 'Both files inspected.', toolCalls: [] };
      },
      tools: [],
      executeTool: async (_name, args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        active -= 1;
        const path = String(JSON.parse(args).path ?? '');
        return JSON.stringify({ success: true, path });
      },
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
      callbacks: {
        onToolResult: (_call, _output, _failed, timing) => {
          if (timing) durations.push(timing.durationMs);
        },
      },
    });

    expect(result.phase).toBe('completed');
    expect(maxActive).toBe(2);
    const toolMessages = (seen[1] ?? []).filter(message => message.role === 'tool');
    expect(toolMessages.map(message => message.tool_call_id)).toEqual(['r1', 'r2']);
    expect(toolMessages[0]?.content).toContain('first.txt');
    expect(toolMessages[1]?.content).toContain('second.txt');
    expect(durations).toHaveLength(2);
    expect(durations.every(duration => duration >= 20)).toBe(true);
  });

  it('does not run mutating tools in parallel', async () => {
    const tracker = new TaskTracker(workspaceRoot);
    let active = 0;
    let maxActive = 0;
    const result = await runAgentLoop({
      workspaceRoot,
      objective: 'sequential writes',
      chat: (async (messages: any[]) => {
        if (messages.filter(message => message.role === 'tool').length < 2) {
          return {
            content: '',
            toolCalls: [
              toolCall('w1', 'write_file', { path: 'one.txt', content: '1' }),
              toolCall('w2', 'write_file', { path: 'two.txt', content: '2' }),
            ],
          };
        }
        return { content: 'Both files written.', toolCalls: [] };
      }) as any,
      tools: [],
      executeTool: async (_name, args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>(resolve => setTimeout(resolve, 15));
        active -= 1;
        return JSON.stringify({ success: true, path: JSON.parse(args).path });
      },
      toolContext: makeContext({ tracker }),
      tracker,
      autoVerifyKinds: [],
    });
    expect(result.phase).toBe('completed');
    expect(maxActive).toBe(1);
  });
});
