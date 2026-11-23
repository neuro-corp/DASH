import { afterEach, describe, expect, it } from 'bun:test';
import { chatXai, listXaiModels } from './xai';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('xAI provider', () => {
  it('lists models with a bearer token', async () => {
    let requestUrl = '';
    let requestHeaders = new Headers();
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        data: [{ id: 'grok-4' }, { id: 'grok-3' }, { id: '' }],
      }), { headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    expect(await listXaiModels('test-key')).toEqual(['grok-4', 'grok-3']);
    expect(requestUrl).toBe('https://api.x.ai/v1/models');
    expect(requestHeaders.get('authorization')).toBe('Bearer test-key');
  });

  it('streams chat completions through the OpenAI-compatible endpoint', async () => {
    let requestUrl = '';
    let requestBody: Record<string, any> = {};
    const frames = [
      { choices: [{ delta: { content: 'Hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
    const streamText = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(streamText, { headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const result = await chatXai('test-key', 'grok-4', [{ role: 'user', content: 'hi' }], []);

    expect(requestUrl).toBe('https://api.x.ai/v1/chat/completions');
    expect(requestBody['model']).toBe('grok-4');
    expect(result.content).toBe('Hello world');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
  });
});
