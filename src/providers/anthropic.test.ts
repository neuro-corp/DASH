import { afterEach, describe, expect, it } from 'bun:test';
import { chatAnthropic, listAnthropicModels } from './anthropic';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sse(events: unknown[]): string {
  return events.map(event => `event: ${(event as { type?: string }).type ?? 'message'}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

describe('Anthropic provider', () => {
  it('streams text, thinking, tool calls, and usage', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
      },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
      { type: 'message_delta', usage: { output_tokens: 42 } },
    ];
    globalThis.fetch = (async () => new Response(sse(events), {
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;

    const receivedText: string[] = [];
    let thinkingNotified = false;
    const result = await chatAnthropic('test-key', 'claude-test', [{ role: 'user', content: 'inspect' }], [], {
      onText: chunk => receivedText.push(chunk),
      onThinking: () => { thinkingNotified = true; },
    });

    expect(receivedText).toEqual(['Hello ', 'world']);
    expect(thinkingNotified).toBe(true);
    expect(result.content).toBe('Hello world');
    expect(result.toolCalls).toEqual([{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    }]);
    expect(result.usage).toEqual({
      promptTokens: 125,
      completionTokens: 42,
      totalTokens: 167,
      cachedPromptTokens: 20,
      cacheWriteTokens: 5,
    });
  });

  it('sends Anthropic headers, system prompt, tools, and generation options', async () => {
    let requestUrl = '';
    let requestHeaders = new Headers();
    let requestBody: Record<string, any> = {};
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(sse([{ type: 'message_stop' }]), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    await chatAnthropic(
      'test-key',
      'claude-test',
      [{ role: 'system', content: 'You are DASH.' }, { role: 'user', content: 'hi' }],
      [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
      {},
      { maxOutputTokens: 512, temperature: 0.2, topP: 0.9 },
    );

    expect(requestUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(requestHeaders.get('x-api-key')).toBe('test-key');
    expect(requestHeaders.get('anthropic-version')).toBe('2023-06-01');
    expect(requestBody['system']).toBe('You are DASH.');
    expect(requestBody['max_tokens']).toBe(512);
    expect(requestBody['temperature']).toBe(0.2);
    expect(requestBody['top_p']).toBe(0.9);
    expect(requestBody['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(requestBody['tools']).toEqual([{
      name: 'read_file',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }]);
  });

  it('converts assistant tool calls and tool results into Anthropic blocks', async () => {
    let requestBody: Record<string, any> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(sse([{ type: 'message_stop' }]), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    await chatAnthropic('test-key', 'claude-test', [
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [{
          id: 'toolu_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'file body' },
    ], []);

    expect(requestBody['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }] },
    ]);
  });

  it('lists models with pagination', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      const afterId = new URL(String(input)).searchParams.get('after_id');
      if (!afterId) {
        return new Response(JSON.stringify({
          data: [{ id: 'claude-sonnet' }],
          has_more: true,
          last_id: 'claude-sonnet',
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: [{ id: 'claude-haiku' }],
        has_more: false,
      }), { headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    expect(await listAnthropicModels('test-key')).toEqual(['claude-sonnet', 'claude-haiku']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('limit=1000');
    expect(calls[1]).toContain('after_id=claude-sonnet');
  });
});
