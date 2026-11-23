import { afterEach, describe, expect, it } from 'bun:test';
import { chatGoogle } from './google';
import { chatNvidia } from './nvidia';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('NVIDIA streaming response parser', () => {
  it('delivers text deltas immediately and collects tool-call fragments', async () => {
    const frames = [
      { choices: [{ delta: { reasoning_content: 'private reasoning' } }] },
      { choices: [{ delta: { content: 'Hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'read_', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { name: 'file', arguments: '"README.md"}' } }] } }] },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = async () => new Response(streamText, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const receivedText: string[] = [];
    let thinkingNotified = false;
    const result = await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'inspect' }], [], {
      onText: chunk => receivedText.push(chunk),
      onThinking: () => { thinkingNotified = true; },
    });

    expect(receivedText).toEqual(['Hello ', 'world']);
    expect(thinkingNotified).toBe(true);
    expect(result.content).toBe('Hello world');
    expect(result.toolCalls).toEqual([{
      id: 'call_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    }]);
  });

  it('does not duplicate ids or names repeated in every stream chunk', async () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '"a.ts"}' } }] } }] },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = (async () => new Response(streamText, {
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;

    const result = await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'inspect' }], [], {});
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.id).toBe('call_1');
    expect(result.toolCalls[0]?.function.name).toBe('read_file');
    expect(result.toolCalls[0]?.function.arguments).toBe('{"path":"a.ts"}');
  });

  it('assigns distinct fallback ids when streamed tool calls omit ids', async () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } }] } }] },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = (async () => new Response(streamText, {
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;

    const result = await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'inspect' }], [], {});
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.id).toBeTruthy();
    expect(result.toolCalls[1]?.id).toBeTruthy();
    expect(result.toolCalls[0]?.id).not.toBe(result.toolCalls[1]?.id);
  });

  it('captures provider-reported token usage from the final stream chunk', async () => {
    const frames = [
      { choices: [{ delta: { content: 'Hi' } }] },
      { choices: [{ delta: {} }] },
      { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = async () => new Response(streamText, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const result = await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'hi' }], []);
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
  });

  it('captures cached-input and reasoning-token details when reported', async () => {
    const frames = [
      { choices: [{ delta: { content: 'Hi' } }] },
      {
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 80, cache_creation_tokens: 10 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = async () => new Response(streamText, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const result = await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'hi' }], []);
    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedPromptTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 12,
    });
  });

  it('applies configurable generation limits without changing defaults', async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    await chatNvidia(
      'test-key',
      'test-model',
      [{ role: 'user', content: 'hi' }],
      [],
      {},
      { maxOutputTokens: 2048, temperature: 0.2, topP: 0.8, reasoningEffort: 'low' },
    );
    expect(requestBody['max_tokens']).toBe(2048);
    expect(requestBody['temperature']).toBe(0.2);
    expect(requestBody['top_p']).toBe(0.8);
    expect(requestBody['reasoning_effort']).toBe('low');
  });

  it('derives token usage when only total_tokens is reported', async () => {
    const streamText = 'data: ' + JSON.stringify({ usage: { total_tokens: 200, completion_tokens: 50 } }) + '\n\ndata: [DONE]\n\n';
    globalThis.fetch = async () => new Response(streamText, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const result = await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'hi' }], []);
    expect(result.usage?.totalTokens).toBe(200);
    expect(result.usage?.completionTokens).toBe(50);
    expect(result.usage?.promptTokens).toBe(150);
  });

  it('requests usage reporting in the stream request body', async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'hi' }], []);
    expect(requestBody['stream_options']).toEqual({ include_usage: true });
  });

  it('falls back to no usage when the provider rejects stream_options', async () => {
    globalThis.fetch = (async (input, init) => {
      if (init === undefined) return undefined as never;
      const body = String((init as RequestInit).body ?? '{}');
      if (body.includes('stream_options')) {
        return new Response('stream_options is not supported', { status: 400 });
      }
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const result = await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'hi' }], []);
    expect(result.usage).toBeUndefined();
    expect(result.content).toBe('');
  });

  it('forwards the task cancellation signal to fetch', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => {
      receivedSignal = init?.signal;
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    await chatNvidia('test-key', 'test-model', [{ role: 'user', content: 'continue' }], [], { signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });
});

describe('Google streaming response parser', () => {
  it('records cached/thought tokens and forwards generation limits', async () => {
    let requestBody: Record<string, any> = {};
    const frames = [
      { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
      {
        usageMetadata: {
          promptTokenCount: 200,
          candidatesTokenCount: 40,
          totalTokenCount: 260,
          cachedContentTokenCount: 120,
          thoughtsTokenCount: 20,
        },
      },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(streamText, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const result = await chatGoogle(
      'test-key',
      'gemini-test',
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'hi' }],
      [],
      {},
      { maxOutputTokens: 2048, temperature: 0.3, topP: 0.9 },
    );
    expect(requestBody['generationConfig']).toEqual({ maxOutputTokens: 2048, temperature: 0.3, topP: 0.9 });
    expect(result.usage?.cachedPromptTokens).toBe(120);
    expect(result.usage?.reasoningTokens).toBe(20);
  });

  it('keeps Google tool-call ids unique across turns', async () => {
    const frames = [
      { candidates: [{ content: { parts: [
        { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
        { functionCall: { name: 'read_file', args: { path: 'b.ts' } } },
      ] } }] },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
    globalThis.fetch = (async () => new Response(streamText, {
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;

    const first = await chatGoogle('test-key', 'gemini-test', [{ role: 'user', content: 'one' }], []);
    const second = await chatGoogle('test-key', 'gemini-test', [{ role: 'user', content: 'two' }], []);
    const ids = [...first.toolCalls, ...second.toolCalls].map(call => call.id);
    expect(first.toolCalls).toHaveLength(2);
    expect(second.toolCalls).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
